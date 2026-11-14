# 💥 The Burner's Archive
> **NASA International Space Apps Challenge 2026**  
> **Challenge:** Harmonizing MODIS and VIIRS Active Fire Hotspots into a Burning Activity Calendar

---

## 📌 Overview
**The Burner's Archive** is an interactive, spatial-temporal web dashboard built to bridge the sensor gap between legacy **MODIS (1km)** satellite data and modern **VIIRS (375m)** observations. By applying a Kernel Density Estimation (KDE) normalization model, our platform reconciles 25+ years of active fire data into a unified, unbroken historical baseline.

## 🚀 Key Features
* **3D CesiumJS Command Globe:** Photorealistic spatial visualization of global fire hotspots with time-series CZML streaming.
* **25-Year Heatmap Calendar:** Interactive grid tracking monthly burning trends and regional anomaly scores from 2000 to 2026.
* **"Show Your Math" Harmonization Toggle:** Instant side-by-side comparison between raw sensor discrepancy and our normalized harmonization model.
* **Regional Anomaly Engine:** Automated early-warning indicator detecting fire activity exceeding historical standard deviations.

## 🛠️ Architecture & Tech Stack
* **Data Pipeline:** Python (`pandas`, `geopandas`, `czml3`)
* **Backend API:** Node.js + Express
* **Frontend:** React, Vite, CesiumJS (`resium`), Tailwind CSS, Recharts

## 💻 Quickstart (GitHub Codespaces)