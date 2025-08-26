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

const { computeRankings } = require('./rankings');

app.get('/api/rankings', async (req, res) => {
  try {
    const leagueId = process.env.LEAGUE_ID || String(req.query.leagueId || '').trim();
    if (!leagueId) return res.status(400).json({ error: 'Missing LEAGUE_ID' });
    const withRank = await computeRankings(leagueId);
    res.json(withRank);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to compute rankings' });
  }
});

app.use(express.static(path.join(__dirname, '..', 'public')));

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});
