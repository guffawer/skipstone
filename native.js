/* Neon Skip native bridge (Capacitor, Android first).
   Loaded before the game script. In a normal browser it only sets NeonNative.native = false, and the game keeps its
   built-in placeholder ads and test purchase panel. Inside the app it connects the game's existing hooks to:
   AdMob (rewarded and interstitial, with Google's consent flow), Google Play Billing (cordova-plugin-purchase),
   Firebase Analytics, native haptics, the Android back button and app pause/resume. Gameplay and economy are unchanged. */
(function () {
  'use strict';
  var CFG = window.NEON_CONFIG || {};
  var Cap = window.Capacitor;
  var isNative = !!(Cap && typeof Cap.isNativePlatform === 'function' && Cap.isNativePlatform());
  var N = window.NeonNative = { native: isNative, ads: null, billing: null, analytics: null, haptics: null };
  if (!isNative) return;

  var P = Cap.Plugins || {};
  var AdMob = P.AdMob, FA = P.FirebaseAnalytics, Hap = P.Haptics, App = P.App, Splash = P.SplashScreen;
  function log() { try { console.log.apply(console, ['[neon]'].concat([].slice.call(arguments))); } catch (e) {} }
  function q(p) { if (p && typeof p.catch === 'function') p.catch(function (e) { log('call failed', e && e.message); }); return p; }
  function audio(on) { try { var s = window.__neonSound; if (s) { if (on) s.resumeAll(); else s.suspendAll(); } } catch (e) {} }
  function $(id) { return document.getElementById(id); }
  function shown(id) { var el = $(id); return !!(el && el.classList.contains('show')); }

  /* ---------- Haptics ---------- */
  N.haptics = {
    impact: function (style) { if (Hap) q(Hap.impact({ style: style || 'LIGHT' })); }
  };

  /* ---------- Analytics: forwards the game's track() events. Firebase limits: names and keys 40 chars, 25 params, flat values. ---------- */
  function clean(p) {
    var o = {}, n = 0, k, v;
    for (k in (p || {})) {
      v = p[k];
      if (v === null || v === undefined) continue;
      if (typeof v === 'boolean') v = v ? 1 : 0;
      else if (typeof v === 'object') v = JSON.stringify(v);
      if (typeof v === 'string') v = v.slice(0, 100);
      o[String(k).slice(0, 40)] = v;
      if (++n >= 25) break;
    }
    return o;
  }
  N.analytics = {
    log: function (name, params) {
      if (!FA || !CFG.firebase) return;
      q(FA.logEvent({ name: String(name).slice(0, 40), params: clean(params) }));
    }
  };

  /* ---------- AdMob: Google's test ad units only until release approval (see build-config.js). ---------- */
  var IDS = CFG.adUnits || {};
  var adsReady = false, consent = null;
  var inter = { loaded: false, loading: false, done: null };
  var rew = { loaded: false, loading: false, done: null, earned: false, waiters: [] };
  function prepInter() {
    if (!AdMob || !adsReady || inter.loaded || inter.loading) return;
    inter.loading = true;
    AdMob.prepareInterstitial({ adId: IDS.interstitial, isTesting: !!CFG.adsTest, immersiveMode: true }).then(function () {
      inter.loaded = true; inter.loading = false;
    }, function (e) { inter.loading = false; log('interstitial load failed', e && e.message); setTimeout(prepInter, 45000); });
  }
  function prepRew() {
    if (!AdMob || !adsReady || rew.loaded || rew.loading) return;
    rew.loading = true;
    AdMob.prepareRewardVideoAd({ adId: IDS.rewarded, isTesting: !!CFG.adsTest, immersiveMode: true }).then(function () {
      rew.loaded = true; rew.loading = false; var w = rew.waiters; rew.waiters = []; w.forEach(function (f) { f(true); });
    }, function (e) {
      rew.loading = false; log('rewarded load failed', e && e.message);
      var w = rew.waiters; rew.waiters = []; w.forEach(function (f) { f(false); });
      setTimeout(prepRew, 45000);
    });
  }
  function finishInter() { audio(true); var cb = inter.done; inter.done = null; prepInter(); if (cb) cb(true); }
  function finishRew() {
    // Give the reward event a moment to arrive if the dismiss event came first
    setTimeout(function () { audio(true); var cb = rew.done, ok = rew.earned; rew.done = null; rew.earned = false; prepRew(); if (cb) cb(ok); }, 350);
  }
  if (AdMob) {
    AdMob.addListener('interstitialAdDismissed', finishInter);
    AdMob.addListener('interstitialAdFailedToShow', finishInter);
    AdMob.addListener('onRewardedVideoAdReward', function () { rew.earned = true; });
    AdMob.addListener('onRewardedVideoAdDismissed', finishRew);
    AdMob.addListener('onRewardedVideoAdFailedToShow', finishRew);
    AdMob.initialize({ initializeForTesting: !!CFG.adsTest, tagForChildDirectedTreatment: false, tagForUnderAgeOfConsent: false, maxAdContentRating: CFG.maxAdRating || 'ParentalGuidance' })
      .then(function () { return AdMob.requestConsentInfo({}); })
      .then(function (info) {
        consent = info;
        if (info && info.status === 'REQUIRED' && info.isConsentFormAvailable) return AdMob.showConsentForm();
        return info;
      })
      .then(function (info) { consent = info || consent; adsReady = !consent || consent.canRequestAds !== false; prepInter(); prepRew(); })
      .catch(function (e) { log('ads init', e && e.message); adsReady = true; prepInter(); prepRew(); });
  }
  N.ads = {
    available: function () { return !!AdMob; },
    rewardReady: function () { return rew.loaded; },
    /* cb(true) after the ad closes; cb(false) when no interstitial is loaded (the game simply continues). */
    interstitial: function (cb) {
      if (!AdMob || !inter.loaded) { prepInter(); cb(false); return; }
      inter.loaded = false; inter.done = cb; audio(false);
      AdMob.showInterstitial().catch(function () { finishInter(); });
    },
    /* cb(true) reward earned, cb(false) closed early, cb(null) no ad available. */
    rewarded: function (cb) {
      if (!AdMob) { cb(null); return; }
      function show() { rew.loaded = false; rew.earned = false; rew.done = cb; audio(false); AdMob.showRewardVideoAd().catch(function () { finishRew(); }); }
      if (rew.loaded) { show(); return; }
      var settled = false, t = setTimeout(function () { if (!settled) { settled = true; cb(null); } }, 9000);
      rew.waiters.push(function (ok) { if (settled) return; settled = true; clearTimeout(t); if (ok) show(); else cb(null); });
      if (!adsReady) adsReady = true;
      prepRew();
    },
    privacyRequired: function () { return !!(consent && consent.privacyOptionsRequirementStatus === 'REQUIRED'); },
    privacyForm: function () { if (AdMob) q(AdMob.showPrivacyOptionsForm()); }
  };

  /* ---------- Google Play Billing (cordova-plugin-purchase). Mode 'test' keeps the in-game test panel; 'play' uses Play Billing. ---------- */
  var CONSUMABLE = ['rescue', 'coins500', 'coins1800', 'coins3500', 'coins8000'];
  var DURABLE = ['noads', 'starter', 'stone_jade', 'stone_obsidian', 'stone_comet'];
  var GKEY = 'neonskip.iap.granted';
  var granted = {};
  try { granted = JSON.parse(localStorage.getItem(GKEY) || '{}') || {}; } catch (e) { granted = {}; }
  function saveGranted() { try { localStorage.setItem(GKEY, JSON.stringify(granted)); } catch (e) {} }
  var B = N.billing = {
    mode: CFG.billing === 'play' ? 'play' : 'test',
    ready: false,
    price: function (id) {
      if (B.mode !== 'play' || !B.ready) return null;
      try { var p = window.CdvPurchase.store.get(id, window.CdvPurchase.Platform.GOOGLE_PLAY); return p && p.pricing ? p.pricing.price : null; } catch (e) { return null; }
    },
    /* done({ ok: false, cancelled, message }) on failure. Success is delivered through window.__neonIAP.grant when Play approves. */
    buy: function (id, done) {
      var C = window.CdvPurchase;
      if (!B.ready || !C) { done({ ok: false, message: 'Store not ready. Try again in a moment.' }); return; }
      var p = C.store.get(id, C.Platform.GOOGLE_PLAY), offer = p && p.getOffer();
      if (!offer) { done({ ok: false, message: 'This item is not available yet.' }); return; }
      offer.order().then(function (err) {
        if (!err) return;
        var cancelled = err.code === C.ErrorCode.PAYMENT_CANCELLED;
        done({ ok: false, cancelled: cancelled, message: cancelled ? '' : (err.message || 'Purchase failed.') });
      });
    }
  };
  function entitleOwned() {
    var C = window.CdvPurchase, api = window.__neonIAP;
    if (!C || !api) return;
    DURABLE.forEach(function (id) { try { if (C.store.owned({ id: id, platform: C.Platform.GOOGLE_PLAY })) api.entitle(id); } catch (e) {} });
  }
  function initStore() {
    var C = window.CdvPurchase;
    if (!C) { log('billing plugin missing'); return; }
    var store = C.store, PT = C.ProductType, PL = C.Platform.GOOGLE_PLAY;
    store.verbosity = CFG.debug ? C.LogLevel.DEBUG : C.LogLevel.WARNING;
    store.register(CONSUMABLE.map(function (id) { return { id: id, type: PT.CONSUMABLE, platform: PL }; })
      .concat(DURABLE.map(function (id) { return { id: id, type: PT.NON_CONSUMABLE, platform: PL }; })));
    store.when()
      .approved(function (t) {
        var api = window.__neonIAP;
        if (t.isAcknowledged) { t.finish(); return; } // already delivered earlier
        (t.products || []).forEach(function (pr) {
          var key = t.transactionId + ':' + pr.id;
          if (granted[key] || !api) return;
          granted[key] = 1; saveGranted();
          api.grant(pr.id, { native: true });
        });
        t.verify();
      })
      .verified(function (receipt) { receipt.finish(); })
      .finished(function () { entitleOwned(); })
      .productUpdated(function () { entitleOwned(); });
    store.error(function (e) { log('billing error', e && e.code, e && e.message); });
    store.initialize([PL]).then(function () { B.ready = true; entitleOwned(); });
  }
  if (B.mode === 'play') document.addEventListener('deviceready', initStore, false);

  /* ---------- Android back button and app lifecycle ---------- */
  if (App) {
    App.addListener('backButton', function () {
      if (shown('adov')) return;                                            // web placeholder ad in progress
      if (shown('intro')) { $('intro').click(); return; }                     // v2.6: back skips the intro
      if (shown('iap')) { $('iapNo').click(); return; }
      if (shown('shop')) { $('shopClose').click(); return; }
      if (shown('lvmap') && $('lvClose').style.display !== 'none') { $('lvClose').click(); return; }
      if (shown('reveal')) { if (!$('revGo').disabled) $('revGo').click(); return; }
      q(App.minimizeApp());                                                 // keep progress and state; never exit mid-level
    });
    App.addListener('pause', function () { audio(false); });
    App.addListener('resume', function () { audio(true); });
  }

  /* v2.6 (R1): hide the launch splash as early as possible. The page behind it is already the same #120B2E with the
     animated intro on top, so the hand-over is seamless. 'load' stays as a fallback in case this runs before the body paints. */
  var splashDone = false;
  function hideSplash() { if (splashDone || !Splash) return; splashDone = true; q(Splash.hide({ fadeOutDuration: 150 })); }
  if (document.readyState !== 'loading') hideSplash(); else document.addEventListener('DOMContentLoaded', hideSplash);
  window.addEventListener('load', hideSplash);
})();
