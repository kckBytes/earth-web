# Earth

A live globe for any phone or computer: real sunlight, city lights on the night side, and live satellite clouds that drift along the measured winds.

**Open it:** https://kckbytes.github.io/earth-web/

**On iPhone:** open the link in Safari, tap **Share → Add to Home Screen**, and it becomes an app (full screen, its own icon).

## Controls
- **Double-tap** the globe: zoom in on that spot. Double-tap again to go closer; at full zoom it comes back out.
- **Drag** to turn the Earth, **pinch** to zoom.
- **● tap:** next city. **● hold and move:** a joystick to fly anywhere.
- **⌂** home city, **− / +** zoom, **◷ hold:** fast-forward time (watch day and night sweep across).
- **⋯** cities (add any city, use your location, choose home) and tilt parallax.

## How it works
- One fragment shader ray-traces the planet per pixel (WebGL 2). It is the same `globe.frag` the Android live wallpaper uses.
- The sun position comes from a low-precision ephemeris, so the day/night line is right to the minute.
- **Clouds** come from EUMETSAT imagery via [clouds.matteason.co.uk](https://clouds.matteason.co.uk) (CC0), checked every 30 minutes.
- **Cloud motion:** the app remembers the last two distinct cloud maps (small copies in your browser), block-matches them into a 64×32 wind field (`flow.js`), and the shader moves the clouds along it in real time. The motion appears once you've opened the app on two cloud updates a few hours apart.
- Everything runs on your device. There's no server and no account; textures are cached for offline use.

## Credits
NASA Visible Earth: Blue Marble Next Generation (day) and Black Marble (night lights). EUMETSAT cloud imagery via clouds.matteason.co.uk. Place search: Open-Meteo. Reverse geocoding: BigDataCloud.
