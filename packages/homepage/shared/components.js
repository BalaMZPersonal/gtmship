(function () {
  'use strict';

  function siteLinks(basePath) {
    return {
      homepage: basePath + 'index.html',
      docs: basePath + 'docs/index.html',
      pricing: basePath + 'pricing/index.html',
      github: 'https://github.com/BalaMZPersonal/gtmship'
    };
  }

  // ---- Homepage floating pill nav ----
  function renderHomepageNav(config) {
    var links = siteLinks(config.basePath);
    return '<nav>'
      + '<div class="wrap">'
      +   '<ul class="nav-links">'
      +     '<li><a href="#story">The Voyage</a></li>'
      +     '<li><a href="#connections-agent">Harbor</a></li>'
      +     '<li><a href="#dashboard">Bridge</a></li>'
      +     '<li><a href="#features">Equipment</a></li>'
      +     '<li><a href="' + links.pricing + '">Pricing</a></li>'
      +     '<li><a href="' + links.docs + '">Docs</a></li>'
      +   '</ul>'
      +   '<div class="nav-divider"></div>'
      +   '<a href="' + links.github + '" class="nav-gh" target="_blank" rel="noreferrer">'
      +     '<i class="ph ph-github-logo"></i> GitHub'
      +   '</a>'
      +   '<a href="#dashboard" class="nav-cta">'
      +     '<i class="ph ph-anchor" style="font-size:13px"></i> Board the Ship'
      +   '</a>'
      + '</div>'
      + '</nav>';
  }

  // ---- Docs / Pricing sticky topbar ----
  function renderSiteTopbar(config) {
    var links = siteLinks(config.basePath);
    var brandLabel = config.brandSuffix
      ? '<span class="docs-brand-label">' + config.brandSuffix + '</span>'
      : '';
    var brandContent = config.showLogo === false
      ? '<span class="docs-brand-mark"></span>'
        + '<span class="docs-brand-wordmark">GTM<span class="docs-brand-wordmark-accent">ship</span></span>'
      : '<img class="docs-brand-logo" src="' + config.basePath + 'gtmship-logo-topbar.png" alt="GTMship" width="320" height="135" decoding="async">';

    var topbarLinksHtml = (config.topbarLinks || []).map(function (l) {
      return '<a href="' + l.href + '">' + l.label + '</a>';
    }).join('');

    var actionsHtml =
        '<a class="docs-ghost-link" href="' + links.homepage + '">Homepage</a>'
      + '<a class="docs-ghost-link" href="' + links.docs + '">Docs</a>'
      + '<a class="docs-ghost-link" href="' + links.pricing + '">Pricing</a>';

    if (config.primaryAction) {
      actionsHtml += '<a class="docs-primary-link" href="'
        + config.primaryAction.href + '">' + config.primaryAction.label + '</a>';
    }

    return '<header class="docs-topbar">'
      + '<div class="docs-topbar-inner">'
      +   '<a class="docs-brand" href="' + links.homepage + '">'
      +     brandContent
      +     brandLabel
      +   '</a>'
      +   '<nav class="docs-topbar-links">' + topbarLinksHtml + '</nav>'
      +   '<div class="docs-topbar-actions">' + actionsHtml + '</div>'
      + '</div>'
      + '</header>';
  }

  // ---- 3-column footer ----
  function renderSiteFooter(config) {
    var links = siteLinks(config.basePath);
    var isHome = config.page === 'home';
    var hp = isHome ? '' : links.homepage;

    return '<footer>'
      + '<div class="site-footer-wrap">'
      +   '<div class="footer-grid">'
      +     '<div class="footer-col">'
      +       '<h4>Product</h4>'
      +       '<ul>'
      +         '<li><a href="' + hp + '#story">The Voyage</a></li>'
      +         '<li><a href="' + hp + '#connections-agent">The Harbor</a></li>'
      +         '<li><a href="' + hp + '#dashboard">The Bridge</a></li>'
      +         '<li><a href="' + hp + '#features">Ship\'s Equipment</a></li>'
      +         '<li><a href="' + links.pricing + '">Pricing</a></li>'
      +       '</ul>'
      +     '</div>'
      +     '<div class="footer-col">'
      +       '<h4>Resources</h4>'
      +       '<ul>'
      +         '<li><a href="' + links.github + '" target="_blank" rel="noreferrer">GitHub repository</a></li>'
      +         '<li><a href="' + links.docs + '">Documentation</a></li>'
      +         '<li><a href="' + links.docs + '#quickstart">Quick start</a></li>'
      +         '<li><a href="' + links.docs + '#how-it-works">How GTMship works</a></li>'
      +       '</ul>'
      +     '</div>'
      +     '<div class="footer-col">'
      +       '<h4>Community</h4>'
      +       '<ul>'
      +         '<li><span class="coming-soon">Issues coming soon</span></li>'
      +         '<li><span class="coming-soon">Discussions coming soon</span></li>'
      +         '<li><span class="coming-soon">Contributing guide coming soon</span></li>'
      +       '</ul>'
      +     '</div>'
      +   '</div>'
      +   '<div class="footer-bottom">'
      +     '&copy; 2026 GTMship contributors. MIT License.'
      +   '</div>'
      + '</div>'
      + '</footer>';
  }

  // ---- Entry point ----
  window.initSharedComponents = function (config) {
    var headerEl = document.getElementById('site-header');
    var footerEl = document.getElementById('site-footer');

    if (headerEl) {
      headerEl.outerHTML = config.page === 'home'
        ? renderHomepageNav(config)
        : renderSiteTopbar(config);
    }

    if (footerEl) {
      footerEl.outerHTML = renderSiteFooter(config);
    }
  };
})();
