# NovaCraft Launcher

Launcher de Minecraft para Windows con interfaz de cristal líquido, verificación
de integridad de archivos y actualizaciones automáticas.

## Qué hace

- **Verifica cada archivo antes de jugar.** Comprueba el jar del cliente, las
  librerías y los recursos contra el SHA1 oficial de Mojang y repone lo que
  esté dañado. Un jar de 0 bytes en el classpath es la causa clásica del
  `NoClassDefFoundError` y del cierre con código 1.
- **Elige el Java correcto solo.** Cada versión de Minecraft declara el Java que
  necesita (1.16 pide 8, 1.20.4 pide 17, 1.21 pide 21). Si no está instalado, lo
  descarga de Temurin y lo guarda para la próxima.
- **Modloaders.** Fabric y Quilt desde su API oficial; Forge y NeoForge
  ejecutando su instalador real.
- **Perfiles independientes.** Cada instancia tiene sus mods, mundos y
  configuración. Las versiones, librerías y recursos se comparten entre todas,
  así que crear un perfil nuevo no vuelve a descargar gigabytes.
- **Cuentas Microsoft** con renovación automática de la sesión, y modo offline.
- **Mods desde Modrinth** comprobando que la versión y el loader encajen con el
  perfil antes de instalar.
- **Presencia en partida.** Detecta si estás en el menú, en un mundo o en un
  servidor leyendo la salida del juego, sin necesidad de ningún mod.

## Desarrollo

```bash
npm install
npm start
```

## Compilar el instalador

```bash
npm run build      # deja el .exe en dist/
npm run release    # compila y publica en GitHub Releases
```

Los pasos completos para publicar y repartirlo están en
[DISTRIBUCION.md](DISTRIBUCION.md).

## Requisitos

Windows 10 o superior. Java lo gestiona el propio launcher.

## Licencia

MIT
