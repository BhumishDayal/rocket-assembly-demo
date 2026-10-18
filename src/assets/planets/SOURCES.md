# Planet texture sources

All maps are equirectangular (2:1), centred on 0° longitude (−180° … +180°), and come from NASA or USGS.
They were fetched on 2026-10-17 and converted with macOS `sips` only.
Total size of the 8 JPEGs is about 3.2 MB (3,321,003 bytes).

Old `visibleearth.nasa.gov` and `earthobservatory.nasa.gov` links now redirect (301) to `science.nasa.gov/earth/earth-observatory/…`. Those redirected pages are the source pages listed below.

**NASA licence basis (applies to files 1–6).** The NASA pages link to the NASA Brand & Usage Guidelines (Earth Observatory) or the NASA Reproduction Guidelines (SVS). From https://www.nasa.gov/nasa-brand-center/images-and-media/:
> "NASA content – images, audio, video, and media files used in the rendition of 3-dimensional models, such as texture maps and polygon data in any format – generally are not subject to copyright in the United States."
> "NASA should be acknowledged as the source of the material."

None of the source pages marks these images as third-party copyrighted.

---

## 1. earth_day.jpg — 2048×1024, RGB, JPEG q82, 466 KB
- **What:** NASA Blue Marble: Next Generation, July 2004, with topography and bathymetry (`world.topo.bathy.200407`). Oceans are dark blue with shaded bathymetry.
- **Source page:** https://science.nasa.gov/earth/earth-observatory/blue-marble-next-generation/base-topography-bathymetry/ (formerly Visible Earth)
- **Download URL:** https://assets.science.nasa.gov/content/dam/science/esd/eo/images/bmng/bmng-topography-bathymetry/july/world.topo.bathy.200407.3x5400x2700.jpg
- **Original:** 5400×2700 JPEG, 2,308,798 bytes. Resampled to 2048×1024.
- **Licence:** NASA Media Usage Guidelines (quoted above). The Blue Marble NG overview page (https://science.nasa.gov/earth/earth-observatory/blue-marble-next-generation/) says: "Anyone using or republishing Blue Marble: Next Generation please credit 'NASA Earth Observatory.'"
- **Credit:** NASA Earth Observatory / Reto Stöckli (Blue Marble: Next Generation, NASA Goddard Space Flight Center)

## 2. earth_night.jpg — 2048×1024, RGB, JPEG q82, 225 KB
- **What:** NASA Earth at Night / Black Marble 2016 colour map, 0.1° global (Suomi NPP VIIRS city lights).
- **Source page:** https://science.nasa.gov/earth/earth-observatory/earth-at-night/maps (formerly Visible Earth image 144898)
- **Download URL:** https://assets.science.nasa.gov/content/dam/science/esd/eo/images/imagerecords/144000/144898/BlackMarble_2016_01deg.jpg
- **Original:** 3600×1800 JPEG, 779,638 bytes. Resampled to 2048×1024.
- **Licence:** NASA Media Usage Guidelines (quoted above).
- **Credit:** NASA Earth Observatory / NASA Goddard Space Flight Center: image by Joshua Stevens, using Suomi NPP VIIRS data from Miguel Román (NASA GSFC). The credit is taken from the matching SVS page https://svs.gsfc.nasa.gov/30876, which says "Please give credit for this item to: NASA's Goddard Space Flight Center".

## 3. earth_clouds.jpg — 2048×1024, single-channel grey, JPEG q82, 809 KB
- **What:** NASA Blue Marble (2002) global cloud composite (`cloud_combined_2048`), grey clouds on black.
- **Source page:** https://science.nasa.gov/earth/earth-observatory/the-blue-marble-true-color-global-imagery-at-1km-resolution (formerly earthobservatory.nasa.gov/features/BlueMarble/BlueMarble_2002.php and Visible Earth image 57747)
- **Download URL:** https://assets.science.nasa.gov/content/dam/science/esd/eo/content-feature/bluemarble/images/cloud_combined_2048.jpg
- **Original:** 2048×1024 RGB JPEG, 829,367 bytes. Same size; converted to grey with the Generic Gray Gamma 2.2 profile and re-encoded.
- **Licence:** The page says: "These images are freely available to educators, scientists, museums, and the public." The NASA Media Usage Guidelines also apply.
- **Credit:** NASA Goddard Space Flight Center. Image by Reto Stöckli (land surface, shallow water, clouds). Enhancements by Robert Simmon.

## 4. earth_bump.jpg — 2048×1024, single-channel grey, JPEG q82, 142 KB
- **What:** Blue Marble NG topography map `gebco_08_rev_elev`: land elevation in grey, oceans pure black (0). Use it as a bump map and as an ocean mask.
- **Source page:** https://science.nasa.gov/earth/earth-observatory/blue-marble-next-generation/topography-bathymetry-maps (formerly Visible Earth image 73934)
- **Download URL:** https://assets.science.nasa.gov/content/dam/science/esd/eo/images/bmng/topography/gebco_08_rev_elev_5400x2700.jpg
- **Original:** 5400×2700 JPEG (grey stored as RGB), 1,244,508 bytes. Resampled to 2048×1024 and converted to grey (Gamma 2.2). The median pixel stays 0 (ocean), so the black ocean mask is kept.
- **Licence:** NASA Media Usage Guidelines (quoted above). Note: the image was made by NASA from GEBCO data. GEBCO currently states that "The GEBCO Grid is placed in the public domain and may be used free of charge" (https://www.gebco.net/data-products/gridded-bathymetry-data/). That page does not separately state terms for the 2008 grid.
- **Credit:** "Imagery by Jesse Allen, NASA's Earth Observatory, using data from the General Bathymetric Chart of the Oceans (GEBCO) produced by the British Oceanographic Data Centre."

## 5. moon_color.jpg — 2048×1024, RGB, JPEG q82, 683 KB
- **What:** NASA SVS CGI Moon Kit colour map (2019 version, with poles), from the LRO LROC WAC colour mosaic.
- **Source page:** https://svs.gsfc.nasa.gov/4720
- **Download URL:** https://svs.gsfc.nasa.gov/vis/a000000/a004700/a004720/lroc_color_poles_2k.tif
- **Original:** 2048×1024 8-bit RGB TIFF, 3,339,438 bytes. Converted to JPEG with no resampling.
- **Licence:** SVS usage statement (https://svs.gsfc.nasa.gov/help/): "All of our content is in the public domain (unless otherwise noted), meaning that it is free to download, use, and redistribute for whatever purposes you see fit." Page 4720 has no other restriction and links to the NASA Reproduction Guidelines.
- **Credit:** NASA's Scientific Visualization Studio (visualizer Ernie Wright, USRA; scientist Noah Petro, NASA/GSFC). Data: LRO LROC WAC colour mosaic (Arizona State University) and LRO LOLA.

## 6. moon_disp.jpg — 1024×512, single-channel grey, 109 KB
- **What:** NASA SVS CGI Moon Kit displacement map, 8-bit (from LOLA elevation).
- **Source page:** https://svs.gsfc.nasa.gov/4720
- **Download URL:** https://svs.gsfc.nasa.gov/vis/a000000/a004700/a004720/ldem_3_8bit.jpg
- **Original:** 1024×512 8-bit grey JPEG, 111,552 bytes. Copied unchanged: it already meets the ≤ 2048×1024 limit, and re-encoding would only lose quality.
- **Licence:** Same SVS public-domain statement as file 5.
- **Credit:** NASA's Scientific Visualization Studio. Data: LRO LOLA DEM.

## 7. mars_color.jpg — 2048×1024, RGB, JPEG q82, 730 KB
- **What:** USGS Astrogeology "Mars Viking Colorized Global Mosaic 232m" (Viking MDIM 2.1 colourised), from its 1 km/pixel ancillary JPEG.
- **Source page:** https://astrogeology.usgs.gov/search/map/mars_viking_colorized_global_mosaic_232m
- **Download URL:** https://astrogeology.usgs.gov/ckan/dataset/7131d503-cdc9-45a5-8f83-5126c0fd397e/resource/5ea881c6-01b3-41fa-a7af-42d2131b54f1/download/mars_viking_mdim21_clrmosaic_1km.jpg
  - This is the smallest version that is at least 2048 wide. The full GeoTIFF is 12 GB; the next size down is a 1024-wide sample.
- **Original:** 21339×10670 JPEG, 36,708,552 bytes. Resampled to 2048×1024.
- **Licence:** The page metadata says: "Access Constraints: Public domain" and "Use Constraints: None".
- **Credit:** NASA Ames (originator) / USGS Astrogeology Science Center (publisher).

## 8. mars_bump.jpg — 1024×512, single-channel grey, JPEG q82, 78 KB
- **What:** MGS MOLA global elevation (DEM) in grey: brighter is higher (Tharsis and Olympus Mons are white; Hellas is black). It contains no baked-in hillshade lighting.
- **Source page:** https://astrogeology.usgs.gov/search/map/mars_mgs_mola_dem_463m
- **Download URL:** https://astrogeology.usgs.gov/ckan/dataset/83c20dbd-e2b3-4e5b-b019-f13d4fdffa38/resource/57f84b24-d56c-42dd-a34d-cf9d61a82d2c/download/mars_mgs_mola_dem_mosaic_global_1024.jpg
  - This is the 1024-wide sample image. The only full-resolution file is a 2 GB 16-bit GeoTIFF, which is over the download limit.
- **Original:** 1024×501 JPEG (grey stored as RGB), 55,192 bytes. Stretched vertically to 1024×512 (+2.2%) to make it exactly 2:1, then converted to grey (Gamma 2.2). The 501-row height suggests the sample may cover about ±88° latitude rather than ±90°. If so, positions near the poles are off by up to about 2°, which does not matter for a bump map.
- **Licence:** The page metadata says: "Access Constraints: CC0 (public domain)" and "Use Constraints: None".
- **Credit:** Goddard Space Flight Center / MOLA Team (originator, Mars Global Surveyor); USGS Astrogeology Science Center (publisher).

---

## Skipped files
None. All 8 files were confirmed public domain or not subject to US copyright. No Solar System Scope, Planet Pixel Emporium, or other CC-BY or third-party maps were used.

## Processing notes
- Every download went into its own empty scratch directory and was converted only with `sips`.
- Example command: `sips -s format jpeg -s formatOptions 82 --resampleHeightWidth 1024 2048 in --out out.jpg`
- Grey maps were converted with `-m "/System/Library/ColorSync/Profiles/Generic Gray Gamma 2.2 Profile.icc"`. A spot-check of mean and percentile values before and after conversion showed differences of 3 grey levels or fewer.
