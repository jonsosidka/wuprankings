const path = require('path');
const { computeRankings } = require('../src/rankings');

// Ensure process cwd is project root so relative data paths resolve on Vercel
process.chdir(path.join(__dirname, '..'));

module.exports = async (req, res) => {
  try {
    const leagueId = process.env.LEAGUE_ID || String(req.query.leagueId || '').trim();
    if (!leagueId) {
      res.status(400).json({ error: 'Missing LEAGUE_ID' });
      return;
    }
    const data = await computeRankings(leagueId);
    res.status(200).json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to compute rankings' });
  }
};

