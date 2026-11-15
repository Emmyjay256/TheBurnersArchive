const express = require('express');
const cors = require('cors');
const axios = require('axios');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json());

app.use('/api', require('./routes/fireData'));
app.use('/api', require('./routes/fireOutlook'));
app.use('/api', require('./routes/askAi'));

// A simple homepage so the root URL doesn't show an error
app.get('/', (req, res) => {
  res.send("🔥 The Burners Archive API is LIVE and running!");
});

// Keys should live in Render's Environment Variables, not in the code!
const MAP_KEY = process.env.FIRMS_MAP_KEY ;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// 1. Health check endpoint for Render cold-starts
app.get('/api/health', (req, res) => {
  res.status(200).json({ status: 'awake' });
});

// 2. Historical Harmonized CZML Endpoint (Serves year/region data)
app.get('/api/fires/:region', (req, res) => {
  const region = req.params.region; // e.g., 'california', '2023', etc.
  
  const filePath = path.join(__dirname, 'data', `fires_${region}.czml`);
  const defaultPath = path.join(__dirname, 'data', 'fires_california.czml');
  
  const targetFile = fs.existsSync(filePath) ? filePath : defaultPath;

  if (fs.existsSync(targetFile)) {
    res.setHeader('Content-Type', 'application/json');
    fs.createReadStream(targetFile).pipe(res);
  } else {
    // Fallback inline sample CZML if the data file isn't built yet
    res.status(200).json([
      {
        "id": "document",
        "name": "Harmonized Fire History",
        "version": "1.0",
        "clock": {
          "interval": "2023-01-01T00:00:00Z/2023-12-31T23:59:59Z",
          "currentTime": "2023-07-01T00:00:00Z",
          "multiplier": 86400,
          "range": "LOOP_STOP",
          "step": "SYSTEM_CLOCK_MULTIPLIER"
        }
      },
      {
        "id": "harmonized_fire_1",
        "availability": "2023-10-06T00:00:00Z/2023-10-16T00:00:00Z",
        "position": { "cartographicDegrees": [-118.4922, 38.2639, 1000] },
        "point": { "color": { "rgba": [255, 69, 0, 200] }, "pixelSize": 19 }
      }
    ]);
  }
});

// 3. Live Threat Monitor Endpoint (Using NOAA-20 VIIRS, future-proofed past Suomi NPP retirement)
app.get('/api/fires/live', async (req, res) => {
  try {
    const url = `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${MAP_KEY}/VIIRS_NOAA20_NRT/world/7`;
    const response = await axios.get(url);
    
    res.setHeader('Content-Type', 'text/csv');
    res.status(200).send(response.data);
  } catch (error) {
    console.error("Error fetching live NASA NOAA-20 data:", error.message);
    res.status(500).json({ error: "Failed to fetch live NASA data" });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 Backend API running on port ${PORT}`);
});