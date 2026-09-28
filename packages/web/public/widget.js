/*!
 * Specfirst badge widget.
 * Usage: <script src="https://.../widget.js" data-address="0x..."></script>
 * Renders one inline badge at the script's position: status, invariant count, and time since
 * issuance (docs/plan.md 3.8: "상태, 불변식 개수, 발급 시점 세 가지만 표시"). Clicking opens the
 * certificate page in a new tab; the host page is never navigated away from or blocked.
 */
(function () {
  'use strict';

  var TONE_COLOR = {
    good: '#1a7f4b',
    warn: '#8a6d00',
    bad: '#a3282e',
    neutral: '#5b6270',
  };

  function statusMeta(status) {
    switch (status) {
      case 'valid':
        return { label: 'certified', tone: 'good' };
      case 'superseded':
        return { label: 'certified, newer version available', tone: 'warn' };
      case 'partial':
        return { label: 'partial verification', tone: 'warn' };
      case 'revoked':
        return { label: 'revoked', tone: 'bad' };
      default:
        return { label: 'no certificate', tone: 'neutral' };
    }
  }

  function timeAgo(iso) {
    var then = new Date(iso).getTime();
    var seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
    if (seconds < 60) return 'just now';
    var minutes = Math.round(seconds / 60);
    if (minutes < 60) return minutes + (minutes === 1 ? ' minute ago' : ' minutes ago');
    var hours = Math.round(minutes / 60);
    if (hours < 24) return hours + (hours === 1 ? ' hour ago' : ' hours ago');
    var days = Math.round(hours / 24);
    if (days < 30) return days + (days === 1 ? ' day ago' : ' days ago');
    var months = Math.round(days / 30);
    if (months < 12) return months + (months === 1 ? ' month ago' : ' months ago');
    var years = Math.round(months / 12);
    return years + (years === 1 ? ' year ago' : ' years ago');
  }

  function styleBadge(el, tone, dashed) {
    el.style.display = 'inline-flex';
    el.style.alignItems = 'center';
    el.style.gap = '6px';
    el.style.fontFamily = 'ui-sans-serif, system-ui, sans-serif';
    el.style.fontSize = '12px';
    el.style.fontWeight = '600';
    el.style.borderRadius = '999px';
    el.style.padding = '3px 10px';
    el.style.textDecoration = 'none';
    el.style.cursor = 'pointer';
    el.style.border = '1px ' + (dashed ? 'dashed' : 'solid') + ' ' + (TONE_COLOR[tone] || TONE_COLOR.neutral);
    el.style.color = TONE_COLOR[tone] || TONE_COLOR.neutral;
  }

  function badgeText(data, meta) {
    var text = meta.label;
    if ((data.status === 'valid' || data.status === 'superseded' || data.status === 'partial') && typeof data.total === 'number') {
      text += ', ' + data.total + ' invariant' + (data.total === 1 ? '' : 's');
    }
    if (data.issuedAt) {
      text += ', ' + timeAgo(data.issuedAt);
    }
    return text;
  }

  function render(container, data, certUrl) {
    var meta = statusMeta(data.status);
    var el = document.createElement('a');
    el.href = certUrl;
    el.target = '_blank';
    el.rel = 'noreferrer';
    el.textContent = badgeText(data, meta);
    styleBadge(el, meta.tone, data.status === 'none');
    container.textContent = '';
    container.appendChild(el);
  }

  function renderUnavailable(container) {
    var el = document.createElement('span');
    el.textContent = 'certificate unavailable';
    styleBadge(el, 'neutral', true);
    container.textContent = '';
    container.appendChild(el);
  }

  // Captured synchronously at parse time: by the time init() actually runs (it may be
  // deferred to DOMContentLoaded below), document.currentScript is no longer set, which would
  // otherwise make every deferred widget instance on the page resolve to the same (last) script
  // tag. Capturing it here, once per <script> evaluation, keeps each embed's own address.
  var thisScript = document.currentScript;

  function findScript() {
    if (thisScript) return thisScript;
    var scripts = document.getElementsByTagName('script');
    for (var i = scripts.length - 1; i >= 0; i -= 1) {
      if (scripts[i].src && scripts[i].src.indexOf('widget.js') !== -1) return scripts[i];
    }
    return null;
  }

  function init() {
    var script = findScript();
    if (!script) return;
    var address = script.getAttribute('data-address');
    if (!address) return;

    var origin;
    try {
      origin = new URL(script.src, window.location.href).origin;
    } catch (e) {
      return;
    }

    var container = document.createElement('span');
    container.className = 'specfirst-widget';
    if (script.parentNode) script.parentNode.insertBefore(container, script.nextSibling);

    fetch(origin + '/api/cert/' + address)
      .then(function (res) {
        if (!res.ok) throw new Error('bad response');
        return res.json();
      })
      .then(function (data) {
        render(container, data, origin + '/c/' + address);
      })
      .catch(function () {
        renderUnavailable(container);
      });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
