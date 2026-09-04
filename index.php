<?php
declare(strict_types=1);

/**
 * `scad` (query param): path to the OpenSCAD file to load, either relative to
 * ALLOWED_ROOT below or absolute -- as long as it resolves inside
 * ALLOWED_ROOT. Defaults to the bundled demo model.
 *
 * `stl` (optional query param): path to a precomputed .stl for the same
 * model/parameters, shown immediately while the real in-browser render is
 * still warming up, instead of a blank viewport.
 *
 * Both are confined to ALLOWED_ROOT (this directory, by default) to prevent
 * path traversal / arbitrary file disclosure. Change ALLOWED_ROOT if your
 * .scad/.stl files live elsewhere on disk.
 */
define('ALLOWED_ROOT', realpath(__DIR__) . '/scad/');
define('DEFAULT_SCAD', 'spool_custom.scad');

/**
 * Resolves $param to a real, readable path inside ALLOWED_ROOT with one of
 * $allowedExtensions, or null if it's missing, escapes ALLOWED_ROOT, doesn't
 * exist, or has the wrong extension.
 */
function resolve_allowed_file(?string $param, array $allowedExtensions): ?string
{
    if ($param === null || $param === '' || strpos($param, "\0") !== false) {
        return null;
    }

    $isAbsolute = preg_match('#^([A-Za-z]:)?[/\\\\]#', $param) === 1;
    $candidate = $isAbsolute ? $param : ALLOWED_ROOT . DIRECTORY_SEPARATOR . $param;

    $real = realpath($candidate);
    if ($real === false || !is_file($real) || !is_readable($real)) {
        return null;
    }

    $withSep = ALLOWED_ROOT . DIRECTORY_SEPARATOR;
    if (strpos($real, $withSep) !== 0) {
        return null;
    }

    $ext = strtolower(pathinfo($real, PATHINFO_EXTENSION));
    if (!in_array($ext, $allowedExtensions, true)) {
        return null;
    }

    return $real;
}

$scadParam = $_GET['scad'] ?? DEFAULT_SCAD;
$scadPath = resolve_allowed_file($scadParam, ['scad']);

$scadLoadError = null;
if ($scadPath === null) {
    $scadLoadError = 'Could not read OpenSCAD file: ' . $scadParam;
    $scadSource = "// No model could be loaded -- see the console panel below.\ncube([10, 10, 10]);\n";
} else {
    $scadSource = file_get_contents($scadPath);
}

$stlParam = isset($_GET['stl']) ? (string) $_GET['stl'] : null;
$stlPath = $stlParam !== null ? resolve_allowed_file($stlParam, ['stl']) : null;

$stlLoadError = null;
$stlBase64 = null;
if ($stlParam !== null) {
    if ($stlPath === null) {
        $stlLoadError = 'Could not read precomputed STL: ' . $stlParam;
    } else {
        $stlBase64 = base64_encode(file_get_contents($stlPath));
    }
}

$jsonFlags = JSON_HEX_TAG | JSON_HEX_AMP | JSON_HEX_APOS | JSON_HEX_QUOT;
?>
<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>OpenSCAD Customizer</title>
  <link rel="stylesheet" href="css/style.css" />
  <script type="importmap">
    {
      "imports": {
        "three": "https://cdn.jsdelivr.net/npm/three@0.185.1/build/three.module.js",
        "three/addons/": "https://cdn.jsdelivr.net/npm/three@0.185.1/examples/jsm/"
      }
    }
  </script>
  <script>
    // Populated server-side from the `scad` / `stl` query parameters.
    window.__SCAD_SOURCE__ = <?= json_encode($scadSource, $jsonFlags) ?>;
    window.__SCAD_LOAD_ERROR__ = <?= json_encode($scadLoadError, $jsonFlags) ?>;
    window.__PRECOMPUTED_STL_BASE64__ = <?= $stlBase64 !== null ? json_encode($stlBase64, $jsonFlags) : 'null' ?>;
    window.__STL_LOAD_ERROR__ = <?= json_encode($stlLoadError, $jsonFlags) ?>;
  </script>
</head>
<body>
  <header class="topbar">
    <h1>OpenSCAD Customizer</h1>
    <div class="topbar-actions">
      <span id="status" class="status">Loading OpenSCAD…</span>
      <button id="export-btn" disabled>Render &amp; Export STL</button>
    </div>
  </header>

  <div class="layout">
    <aside id="controls" class="sidebar" aria-label="Model parameters">
      <p class="sidebar-hint">Parsing model…</p>
    </aside>

    <main class="viewport">
      <div id="viewer"></div>
      <div id="viewer-overlay" class="viewer-overlay" hidden>
        <span id="viewer-overlay-text">Rendering…</span>
        <div class="progress-bar" aria-hidden="true"><div class="progress-bar-fill"></div></div>
      </div>
    </main>
  </div>

  <details id="log-panel" class="log-panel">
    <summary>Console output</summary>
    <pre id="log-output"></pre>
  </details>

  <script type="module" src="js/app.js"></script>
</body>
</html>
