<?php
declare(strict_types=1);

/**
 * `scad` (query param): path to the OpenSCAD file to load, either relative to
 * ALLOWED_ROOT below or absolute -- as long as it resolves inside
 * ALLOWED_ROOT. Defaults to the bundled demo model. Ignored if `url` is given.
 *
 * `url` (optional query param): an http(s) URL to fetch a .scad file's source
 * from instead of a local file. Takes precedence over `scad` when present.
 * Fetching is SSRF-guarded: only http/https, only to hosts that resolve to a
 * public IPv4 address (private/loopback/link-local/reserved/CGNAT ranges are
 * blocked), the resolved IP is pinned for the actual request so DNS can't be
 * rebound between the check and the fetch, redirects are followed manually
 * (each hop re-validated, capped at REMOTE_FETCH_MAX_REDIRECTS), and the
 * response body is capped at REMOTE_FETCH_MAX_BYTES.
 *
 * `stl` (optional query param): path to a precomputed .stl for the same
 * model/parameters, shown immediately while the real in-browser render is
 * still warming up, instead of a blank viewport.
 *
 * `scad`/`stl` local paths are confined to ALLOWED_ROOT (this directory, by
 * default) to prevent path traversal / arbitrary file disclosure. Change
 * ALLOWED_ROOT if your .scad/.stl files live elsewhere on disk.
 */
define('ALLOWED_ROOT', realpath(__DIR__) . '/scad');
define('DEFAULT_SCAD', 'spool_custom.scad');
define('REMOTE_FETCH_MAX_BYTES', 2 * 1024 * 1024);
define('REMOTE_FETCH_MAX_REDIRECTS', 5);
define('REMOTE_FETCH_TIMEOUT_SECONDS', 15);

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

/**
 * True if $ip (a dotted-quad IPv4 literal) is a public, routable address:
 * not private/loopback/link-local/reserved (PHP's built-in filter flags),
 * and not RFC 6598 shared/CGNAT space (100.64.0.0/10), which those flags do
 * not cover.
 */
function is_public_ipv4(string $ip): bool
{
    if (filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_IPV4 | FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE) === false) {
        return false;
    }
    $long = ip2long($ip);
    if ($long === false) {
        return false;
    }
    // 100.64.0.0/10
    if (($long & 0xFFC00000) === ip2long('100.64.0.0')) {
        return false;
    }
    return true;
}

/**
 * Resolves $host (an IPv4 literal or hostname) to a public IPv4 address, or
 * null if it's not one / doesn't resolve to one. Only the first public IP
 * found among the resolved addresses is used, and that same IP is pinned via
 * CURLOPT_RESOLVE for the actual fetch so DNS can't be rebound afterward.
 */
function resolve_public_ipv4(string $host): ?string
{
    if (filter_var($host, FILTER_VALIDATE_IP, FILTER_FLAG_IPV4) !== false) {
        return is_public_ipv4($host) ? $host : null;
    }
    $ips = gethostbynamel($host);
    if ($ips === false) {
        return null;
    }
    foreach ($ips as $ip) {
        if (is_public_ipv4($ip)) {
            return $ip;
        }
    }
    return null;
}

/**
 * Fetches a .scad source from an http(s) URL, guarded against SSRF (see the
 * `url` doc comment above). Returns [source, null] on success or
 * [null, errorMessage] on failure. Redirects are handled manually so each hop
 * gets the same host/IP validation as the initial request.
 */
function fetch_remote_scad(string $url): array
{
    if (!function_exists('curl_init')) {
        return [null, 'Remote fetch requires the PHP curl extension, which is not installed.'];
    }

    $current = $url;
    for ($hop = 0; $hop <= REMOTE_FETCH_MAX_REDIRECTS; $hop++) {
        $parts = parse_url($current);
        if ($parts === false || !isset($parts['scheme'], $parts['host'])) {
            return [null, 'Invalid URL: ' . $current];
        }

        $scheme = strtolower($parts['scheme']);
        if ($scheme !== 'http' && $scheme !== 'https') {
            return [null, 'Only http/https URLs are allowed: ' . $current];
        }

        $host = $parts['host'];
        $port = $parts['port'] ?? ($scheme === 'https' ? 443 : 80);

        $ip = resolve_public_ipv4($host);
        if ($ip === null) {
            return [null, 'URL host does not resolve to a public address: ' . $host];
        }

        $body = '';
        $bytesRead = 0;
        $tooLarge = false;

        $ch = curl_init();
        curl_setopt_array($ch, [
            CURLOPT_URL => $current,
            CURLOPT_RESOLVE => ["{$host}:{$port}:{$ip}"],
            CURLOPT_IPRESOLVE => CURL_IPRESOLVE_V4,
            CURLOPT_FOLLOWLOCATION => false,
            CURLOPT_PROTOCOLS => CURLPROTO_HTTP | CURLPROTO_HTTPS,
            CURLOPT_REDIR_PROTOCOLS => CURLPROTO_HTTP | CURLPROTO_HTTPS,
            CURLOPT_CONNECTTIMEOUT => 5,
            CURLOPT_TIMEOUT => REMOTE_FETCH_TIMEOUT_SECONDS,
            CURLOPT_SSL_VERIFYPEER => true,
            CURLOPT_SSL_VERIFYHOST => 2,
            CURLOPT_USERAGENT => 'web-customizer-scad-fetch/1.0',
            CURLOPT_HEADER => false,
            CURLOPT_WRITEFUNCTION => function ($ch, $chunk) use (&$body, &$bytesRead, &$tooLarge): int {
                $bytesRead += strlen($chunk);
                if ($bytesRead > REMOTE_FETCH_MAX_BYTES) {
                    $tooLarge = true;
                    return 0; // returning less than strlen($chunk) aborts the transfer
                }
                $body .= $chunk;
                return strlen($chunk);
            },
        ]);

        $ok = curl_exec($ch);
        $errno = curl_errno($ch);
        $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
        $redirectUrl = curl_getinfo($ch, CURLINFO_REDIRECT_URL);
        curl_close($ch);

        if ($ok === false) {
            if ($tooLarge) {
                return [null, 'Remote file exceeds the ' . (REMOTE_FETCH_MAX_BYTES / (1024 * 1024)) . 'MB size limit: ' . $current];
            }
            return [null, 'Failed to fetch URL (curl error ' . $errno . '): ' . $current];
        }

        if ($httpCode >= 300 && $httpCode < 400) {
            if (!$redirectUrl) {
                return [null, 'Redirect response had no Location header: ' . $current];
            }
            $current = $redirectUrl;
            continue;
        }

        if ($httpCode < 200 || $httpCode >= 300) {
            return [null, 'Remote server returned HTTP ' . $httpCode . ': ' . $current];
        }

        if (!mb_check_encoding($body, 'UTF-8')) {
            return [null, 'Remote file is not valid UTF-8 text: ' . $current];
        }

        return [$body, null];
    }

    return [null, 'Too many redirects: ' . $url];
}

$urlParam = isset($_GET['url']) && $_GET['url'] !== '' ? (string) $_GET['url'] : null;
if ($urlParam == null) {
    $thingParam = isset($_GET['thing']) && $_GET['thing'] !== '' ? (string) $_GET['thing'] : null;
    if ($thingParam !== null) {
        $urlParam = 'https://www.thingiverse.com/download:' . $thingParam;
    }
}

$scadLoadError = null;
if ($urlParam !== null) {
    [$scadSource, $scadLoadError] = fetch_remote_scad($urlParam);
    if ($scadLoadError !== null) {
        $scadSource = "// No model could be loaded -- see the console panel below.\ncube([10, 10, 10]);\n";
    }
} else {
    $scadParam = $_GET['scad'] ?? DEFAULT_SCAD;
    $scadPath = resolve_allowed_file($scadParam, ['scad']);

    if ($scadPath === null) {
        $scadLoadError = 'Could not read OpenSCAD file: ' . $scadParam;
        $scadSource = "// No model could be loaded -- see the console panel below.\ncube([10, 10, 10]);\n";
    } else {
        $scadSource = file_get_contents($scadPath);
    }
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
      <label class="fast-toggle" title="Live GPU CSG preview (OpenCSG-style, rendered by js/fast-preview/). Approximate by design ($fn capped, booleans not evaluated); the accurate mesh render runs only on Render &amp; Export STL. With fast preview off or unavailable the app falls back to a full mesh render on every parameter change.">
        <input type="checkbox" id="fast-toggle" checked />
        Fast preview
      </label>
      <span id="fast-badge" class="fast-badge" hidden></span>
      <span id="status" class="status">Loading OpenSCAD…</span>
      <button id="export-btn" disabled>Render &amp; Export STL</button>
      <button id="about-btn" type="button">About</button>
    </div>
  </header>

  <div id="about-modal" class="modal-overlay" hidden>
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="about-modal-title">
      <h2 id="about-modal-title">About</h2>
      <p>
        This software is based on
        <a href="https://openscad.org/" target="_blank" rel="noopener">OpenSCAD</a>
        and is released under the
        <a href="https://www.gnu.org/licenses/old-licenses/gpl-2.0.html" target="_blank" rel="noopener">GNU General Public License v2</a>.
      </p>
      <p>
        Source code is available at
        <a href="https://github.com/fsantini/web-customizer" target="_blank" rel="noopener">github.com/fsantini/web-customizer</a>.
      </p>
      <p class="modal-disclaimer">
        This software is provided as-is, without warranty of any kind, express or
        implied, including but not limited to the warranties of merchantability,
        fitness for a particular purpose, and noninfringement. In no event shall the
        authors be liable for any claim, damages, or other liability arising from
        the use of this software.
      </p>
      <button id="about-modal-close" type="button">Close</button>
    </div>
  </div>

  <div class="layout">
    <aside id="controls" class="sidebar" aria-label="Model parameters">
      <p class="sidebar-hint">Parsing model…</p>
    </aside>

    <main class="viewport">
      <div id="viewer"></div>
      <canvas id="fast-canvas" width="16" height="16"></canvas>
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
