/* The download buttons ship pointing at the releases page, which is correct
 * forever and needs no JavaScript. This upgrades them to the current version's
 * .dmg — the filename carries the version, so there is no fixed URL to write
 * into the HTML.
 *
 * Every failure path leaves the markup alone: an unreachable API, the hourly
 * rate limit, a release with no .dmg attached. The fallback is already right,
 * so there is nothing to report to the reader. */

(function () {
  "use strict";

  var RELEASE = "https://api.github.com/repos/nicoten/speck/releases/latest";

  function apply(release) {
    var assets = Array.isArray(release && release.assets) ? release.assets : [];
    var dmg = null;

    for (var i = 0; i < assets.length; i++) {
      var name = String(assets[i].name || "");
      if (/\.dmg$/i.test(name) && assets[i].browser_download_url) {
        dmg = assets[i];
        break;
      }
    }

    if (!dmg) return;

    // "v0.4.0" and "0.4.0" both reach the button as "0.4.0".
    var version = String(release.tag_name || "").replace(/^v/, "");
    var label = version ? "Download Speck " + version : "Download Speck";
    var links = document.querySelectorAll("[id^=download-link]");

    for (var j = 0; j < links.length; j++) {
      links[j].href = dmg.browser_download_url;
      links[j].textContent = label;
    }
  }

  fetch(RELEASE, { headers: { Accept: "application/vnd.github+json" } })
    .then(function (response) {
      if (!response.ok) throw new Error("release lookup failed: " + response.status);
      return response.json();
    })
    .then(apply)
    .catch(function () {
      /* The static link stands. */
    });
})();
