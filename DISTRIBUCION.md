# Repartir NovaCraft a tus amigos

Tus amigos instalan **una sola vez**. A partir de ahí, cada vez que publiques
una versión nueva, el launcher se la descarga solo y les avisa. Nunca más hay
que pasar un instalador a mano.

---

## 1. Configurar tu usuario de GitHub (solo la primera vez)

Hay **dos** sitios con el marcador `CAMBIA-ESTO-POR-TU-USUARIO`:

- `electron-builder.yml` → campo `owner:`
- `package.json` → campo `repository.url`

Cambia los dos por tu usuario real de GitHub.

> El repositorio tiene que ser **público**. Si lo pones privado, los launchers
> de tus amigos no podrán leer las actualizaciones sin un token, y ese token
> no se puede repartir.

## 2. Crear el repositorio y subirlo

Crea el repositorio en <https://github.com/new> con el nombre
`novacraft-launcher`, **sin** README ni .gitignore (ya los tiene), y luego:

```bash
git remote add origin https://github.com/TU-USUARIO/novacraft-launcher.git
git push -u origin master
```

## 3. Token para publicar

electron-builder necesita permiso para subir los archivos a las Releases.

1. Ve a <https://github.com/settings/tokens> → *Generate new token (classic)*
2. Marca solo el permiso **`repo`**
3. Antes de publicar, en la terminal:

```bash
export GH_TOKEN=tu_token_aqui
```

> El token es como tu contraseña. No lo subas al repositorio ni lo pegues en
> Discord. El `.gitignore` ya bloquea los archivos `.env` por si acaso.

---

## Publicar una versión nueva

Este es el ciclo completo cada vez que cambies algo:

**1. Sube el número de versión** en `package.json`:

```json
"version": "2.0.1"
```

Esto es lo único que decide si tus amigos reciben la actualización. Si no lo
subes, para ellos no hay nada nuevo. Usa `2.0.1` para arreglos, `2.1.0` para
funciones nuevas.

**2. Guarda los cambios:**

```bash
git add -A && git commit -m "Arreglado X" && git push
```

**3. Publica:**

```bash
npm run release
```

Eso compila el instalador y lo sube a una Release de GitHub junto con
`latest.yml`, que es el archivo que consultan los launchers instalados.

**4. Publica la Release.** electron-builder la deja como *borrador*. Entra en
la pestaña *Releases* de tu repositorio y pulsa **Publish release**. Hasta que
no la publiques, nadie la recibe.

---

## Qué ven tus amigos

1. Abren el launcher y a los pocos segundos aparece una barra:
   *"Hay una version nueva (2.0.1). Descargando..."*
2. Se descarga sola en segundo plano mientras siguen jugando.
3. Cuando termina: *"La version 2.0.1 esta lista para instalarse"* con un
   botón **Reiniciar e instalar**.
4. Si lo ignoran, se instala igualmente la próxima vez que cierren el launcher.

También pueden comprobarlo a mano en **Ajustes → Actualizaciones**.

---

## Solo probar el instalador, sin publicar

```bash
npm run build
```

Deja el `.exe` en `dist/` sin tocar GitHub. Útil para probar antes de publicar.

---

## Cosas que te van a pasar

**"Windows protegió tu PC" al instalar.** Normal: el ejecutable no está firmado
digitalmente. Tus amigos deben pulsar *Más información* → *Ejecutar de todas
formas*. Quitarlo del todo requiere comprar un certificado de firma de código
(unos 200-400 € al año). No es obligatorio.

**La actualización no llega.** Repasa, por este orden:
- ¿Subiste la versión en `package.json`?
- ¿Publicaste la Release (no está en borrador)?
- ¿El repositorio es público?
- ¿El nombre del `.exe` coincide con el `path:` de `latest.yml`? Debe ser
  `NovaCraft-Launcher-Setup-X.Y.Z.exe`, **sin espacios**. Con espacios el
  launcher da 404 al buscarlo. Por eso el nombre está fijado en
  `electron-builder.yml`; si lo subes a mano, respétalo.

**En desarrollo no busca actualizaciones.** Es a propósito: con `npm start` no
hay versión instalada contra la que comparar. En Ajustes verás
*"Solo disponible en la app instalada"*.

**Un amigo dice que le peta.** Pídele este archivo:

```
%APPDATA%\novacraft-launcher\logs\main.log
```

Ahí queda registrado cualquier error de arranque con su traza completa.
