const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

const DATA_DIR = path.join(__dirname, '..', 'data');
const DEFAULT_LEAGUE_ID = '1257482024906657792';
// Known name aliases to bridge Sleeper vs projections differences
// Use lowercase normalized keys
const NAME_ALIASES = new Map([
  ['josh palmer', 'joshua palmer'],
  ['joshua palmer', 'josh palmer'],
  ['hollywood brown', 'marquise brown'],
  ['marquise brown', 'hollywood brown'],
  ['chig okonkwo', 'chigoziem okonkwo'],
  ['chigoziem okonkwo', 'chig okonkwo'],
  ['cam ward', 'cameron ward'],
  ['cameron ward', 'cam ward'],
]);

function loadCsvProjections(filename, position) {
  return new Promise((resolve, reject) => {
    const records = new Map();
    fs.createReadStream(path.join(DATA_DIR, filename))
      .pipe(parse({ columns: true, skip_empty_lines: true }))
      .on('data', (row) => {
        const player = (row.player || '').trim();
        const fantasy = parseFloat(row.fantasy || row.FPTS || row.points || '0');
        if (player && !Number.isNaN(fantasy)) {
          // Preserve team when available (useful for DST matching)
          const team = (row.team || '').trim();
          records.set(player, { player, position, fantasy, team });
        }
      })
      .on('error', reject)
      .on('end', () => resolve(records));
  });
}

async function loadAllProjections() {
  const [qbs, rbs, wrs, tes, ks, dsts] = await Promise.all([
    loadCsvProjections('QB.csv', 'QB'),
    loadCsvProjections('RB.csv', 'RB'),
    loadCsvProjections('WR.csv', 'WR'),
    loadCsvProjections('TE.csv', 'TE'),
    loadCsvProjections('K.csv', 'K'),
    loadCsvProjections('DST.csv', 'DST'),
  ]);
  return { qbs, rbs, wrs, tes, ks, dsts };
}

function normalizeName(name) {
  return name
    .toLowerCase()
    .replace(/\./g, '')
    .replace(/'/g, '')
    .replace(/-/g, ' ')
    // strip common suffixes
    .replace(/\b(jr|sr|ii|iii|iv)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildNameIndex(projectionsMaps) {
  const index = new Map();
  for (const map of Object.values(projectionsMaps)) {
    for (const { player, position, fantasy } of map.values()) {
      const key = normalizeName(player);
      const keys = [key];
      const alias = NAME_ALIASES.get(key);
      if (alias) keys.push(alias);
      for (const k of keys) {
        if (!index.has(k)) index.set(k, []);
        index.get(k).push({ player, position, fantasy });
      }
    }
  }
  return index;
}

async function fetchSleeperLeagueRosters(leagueId) {
  // Get users to map user_id -> display_name/team name
  const [usersRes, rostersRes, playersRes] = await Promise.all([
    axios.get(`https://api.sleeper.app/v1/league/${leagueId}/users`),
    axios.get(`https://api.sleeper.app/v1/league/${leagueId}/rosters`),
    axios.get('https://api.sleeper.app/v1/players/nfl'),
  ]);

  const usersById = new Map();
  for (const u of usersRes.data || []) {
    usersById.set(String(u.user_id), u);
  }

  const players = playersRes.data || {};

  const rosters = [];
  for (const r of rostersRes.data || []) {
    const owner = usersById.get(String(r.owner_id));
    const teamName = owner?.metadata?.team_name || owner?.display_name || `Team ${r.roster_id}`;
    const allIds = (r.players || []).map(String);
    const startersSet = new Set((r.starters || []).map(String));

    const entries = [];
    for (const pid of allIds) {
      const p = players[pid];
      if (!p) continue;
      // Build display name and position
      const fullName = [p.first_name, p.last_name].filter(Boolean).join(' ').trim() || p.full_name || p.last_name || pid;
      const position = (p.position === 'DEF' ? 'DST' : p.position) || 'FLEX';
      const isStarter = startersSet.has(pid);
      entries.push({ id: pid, name: fullName, position, isStarter });
    }

    rosters.push({ rosterId: r.roster_id, teamName, entries });
  }

  return rosters;
}

function estimateTeamPoints(roster, nameIndex, dstMap) {
  let total = 0;
  const details = [];
  for (const entry of roster.entries) {
    const key = normalizeName(entry.name);
    let match = (nameIndex.get(key) || []).find(m => m.position === entry.position);
    if (!match) {
      const alias = NAME_ALIASES.get(key);
      if (alias) {
        match = (nameIndex.get(alias) || []).find(m => m.position === entry.position);
      }
    }
    // Fallback: if exact position not found, take any match
    if (!match) {
      const candidates = nameIndex.get(key);
      if (candidates && candidates.length > 0) match = candidates[0];
    }
    if (match) {
      total += match.fantasy;
      details.push({ name: entry.name, position: entry.position, projected: match.fantasy, isStarter: !!entry.isStarter });
    } else if (entry.position === 'DEF' || entry.position === 'DST') {
      // Sleeper uses 'DEF' for team defenses. Try mapping against DST.csv by team code.
      // Attempt to match like "Denver D/ST" to team.
      for (const { player, fantasy, team } of dstMap.values()) {
        if (player.toLowerCase().includes('d/st')) {
          const teamName = player.split(' D/ST')[0];
          if (
            entry.name.toLowerCase().includes(teamName.toLowerCase()) ||
            (team && entry.name.toLowerCase().includes(team.toLowerCase()))
          ) {
            total += fantasy;
            details.push({ name: entry.name, position: entry.position, projected: fantasy, isStarter: !!entry.isStarter });
            break;
          }
        }
      }
    } else {
      details.push({ name: entry.name, position: entry.position, projected: 0, isStarter: !!entry.isStarter });
    }
  }
  return { total, details };
}

app.get('/api/rankings', async (req, res) => {
  try {
    const leagueId = (String(req.query.leagueId || '').trim()) || (process.env.LEAGUE_ID || '').trim() || DEFAULT_LEAGUE_ID;
    if (!leagueId) return res.status(400).json({ error: 'Missing LEAGUE_ID' });

    const projections = await loadAllProjections();
    const nameIndex = buildNameIndex(projections);
    const rosters = await fetchSleeperLeagueRosters(leagueId);

    const results = rosters.map((roster) => {
      const { total, details } = estimateTeamPoints(roster, nameIndex, projections.dsts);
      return { teamName: roster.teamName, totalProjected: total, players: details };
    });

    results.sort((a, b) => b.totalProjected - a.totalProjected);
    const withRank = results.map((r, idx) => ({ rank: idx + 1, ...r }));
    res.json(withRank);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to compute rankings' });
  }
});

// Available free agents based on projections vs rostered players
app.get('/api/available', async (req, res) => {
  try {
    const leagueId = (String(req.query.leagueId || '').trim()) || (process.env.LEAGUE_ID || '').trim() || DEFAULT_LEAGUE_ID;
    if (!leagueId) return res.status(400).json({ error: 'Missing LEAGUE_ID' });

    const projections = await loadAllProjections();
    const rosters = await fetchSleeperLeagueRosters(leagueId);

    // Build position -> Set of normalized rostered names (include alias when exists)
    const rosteredByPos = new Map();
    const rosteredDstTeams = []; // strings of defense names from Sleeper (e.g., "Denver Broncos")
    for (const r of rosters) {
      for (const entry of r.entries) {
        const pos = entry.position;
        if (!rosteredByPos.has(pos)) rosteredByPos.set(pos, new Set());
        const set = rosteredByPos.get(pos);
        const key = normalizeName(entry.name);
        set.add(key);
        const alias = NAME_ALIASES.get(key);
        if (alias) set.add(alias);
        if (pos === 'DST' || pos === 'DEF') {
          rosteredDstTeams.push(entry.name.toLowerCase());
        }
      }
    }

    function isDstRostered(dstPlayerName, teamCode) {
      // dstPlayerName like "Denver D/ST" -> extract team
      const lower = String(dstPlayerName || '').toLowerCase();
      let teamName = lower;
      if (lower.includes(' d/st')) teamName = lower.split(' d/st')[0];
      for (const rosterName of rosteredDstTeams) {
        if (rosterName.includes(teamName) || (teamCode && rosterName.includes(String(teamCode).toLowerCase()))) {
          return true;
        }
      }
      return false;
    }

    const available = [];
    const allMaps = [projections.qbs, projections.rbs, projections.wrs, projections.tes, projections.ks, projections.dsts];
    for (const map of allMaps) {
      for (const rec of map.values()) {
        const { player, position, fantasy, team } = rec;
        if (position === 'DST') {
          if (!isDstRostered(player, team)) {
            available.push({ player, position, projected: fantasy, team });
          }
          continue;
        }
        const set = rosteredByPos.get(position);
        const key = normalizeName(player);
        const alias = NAME_ALIASES.get(key);
        const taken = (set && (set.has(key) || (alias && set.has(alias)))) || false;
        if (!taken) {
          available.push({ player, position, projected: fantasy, team });
        }
      }
    }

    available.sort((a, b) => b.projected - a.projected);
    res.json({ count: available.length, available });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to compute available players' });
  }
});

// Serve hidden FA page without extension
app.get('/fa', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'fa.html'));
});

app.use(express.static(path.join(__dirname, '..', 'public')));

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});
