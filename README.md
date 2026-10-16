# FloodSim

Simulador 3D de lluvias torrenciales e inundaciones sobre relieve real y datos de OpenStreetMap. Empieza en Móra la Nova, pero sirve para cualquier lugar.

**Abrir:** https://xnogues.github.io/floodsim/

- `index.html`, `app.js`, `sim.worker.js`: la aplicación (sin compilación).
- `FloodSim.html`: la misma app en un solo archivo, para abrirla con doble clic.

Mapa: MapLibre GL. Relieve: AWS Terrain Tiles. Edificios y cauces: OpenStreetMap (Overpass). Motor hidráulico: aproximación inercial local 2D (Bates et al. 2010) en un Web Worker.

Herramienta divulgativa: relieve de ~30 m, sin alcantarillado, puentes ni muros. No sirve para decisiones de seguridad; para eso, los mapas oficiales del [SNCZI](https://sig.mapama.gob.es/snczi/).
