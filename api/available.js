const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse');

// Location of CSV data in the repository (read-only on Vercel)
const DATA_DIR = path.join(process.cwd(), 'data');
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
    const filePath = path.join(DATA_DIR, filename);
    fs.createReadStream(filePath)
      .pipe(parse({ columns: true, skip_empty_lines: true }))
      .on('data', (row) => {
        const player = (row.player || '').trim();
        const fantasy = parseFloat(row.fantasy || row.FPTS || row.points || '0');
        if (player && !Number.isNaN(fantasy)) {
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
    .replace(/\b(jr|sr|ii|iii|iv)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

async function fetchSleeperLeagueRosters(leagueId) {
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
      const fullName = [p.first_name, p.last_name].filter(Boolean).join(' ').trim() || p.full_name || p.last_name || pid;
      const position = (p.position === 'DEF' ? 'DST' : p.position) || 'FLEX';
      const isStarter = startersSet.has(pid);
      entries.push({ id: pid, name: fullName, position, isStarter });
    }

    rosters.push({ rosterId: r.roster_id, teamName, entries });
  }

  return rosters;
}

module.exports = async (req, res) => {
  try {
    const leagueId =
      (req.query && req.query.leagueId ? String(req.query.leagueId).trim() : '') ||
      (process.env.LEAGUE_ID || '').trim() ||
      DEFAULT_LEAGUE_ID;
    if (!leagueId) return res.status(400).json({ error: 'Missing LEAGUE_ID' });

    const projections = await loadAllProjections();
    const rosters = await fetchSleeperLeagueRosters(leagueId);

    const rosteredByPos = new Map();
    const rosteredDstTeams = [];
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
    res.status(200).json({ count: available.length, available });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to compute available players' });
  }
};


