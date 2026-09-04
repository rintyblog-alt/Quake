/* 地図投影とビュー操作 (Web メルカトル + パン / ズーム) */
(function (global) {
  'use strict';

  function Projection(width, height) {
    this.width = width;
    this.height = height;
    this.centerLat = 37.0;
    this.centerLon = 137.5;
    this.zoom = 1.0;          // 1 のとき日本全体が収まる
    this.baseScale = 1.0;
    this.recompute();
  }

  var MAX_LAT = 85.05112878;

  Projection.prototype.mercY = function (lat) {
    var l = Math.max(-MAX_LAT, Math.min(MAX_LAT, lat));
    var r = l * Math.PI / 180;
    return Math.log(Math.tan(Math.PI / 4 + r / 2));
  };
  Projection.prototype.invMercY = function (y) {
    return (2 * Math.atan(Math.exp(y)) - Math.PI / 2) * 180 / Math.PI;
  };

  /* 日本全域が収まるよう基準スケールを決める */
  Projection.prototype.recompute = function () {
    var lonSpan = 32.0;   // 122E - 154E
    var latTop = this.mercY(46.5), latBottom = this.mercY(23.0);
    var sx = this.width / (lonSpan * Math.PI / 180);
    var sy = this.height / (latTop - latBottom);
    this.baseScale = Math.min(sx, sy) * 0.98;
  };

  Projection.prototype.resize = function (w, h) {
    this.width = w; this.height = h; this.recompute();
  };

  Projection.prototype.scale = function () { return this.baseScale * this.zoom; };

  Projection.prototype.project = function (lat, lon) {
    var s = this.scale();
    var x = this.width / 2 + (lon - this.centerLon) * Math.PI / 180 * s;
    var y = this.height / 2 - (this.mercY(lat) - this.mercY(this.centerLat)) * s;
    return [x, y];
  };

  Projection.prototype.unproject = function (x, y) {
    var s = this.scale();
    var lon = this.centerLon + (x - this.width / 2) / s * 180 / Math.PI;
    var lat = this.invMercY(this.mercY(this.centerLat) - (y - this.height / 2) / s);
    return [lat, lon];
  };

  /* 画面上の 1 px に対応する距離 [km] (中心緯度基準) */
  Projection.prototype.kmPerPixel = function () {
    var s = this.scale();
    return 111.32 * Math.cos(this.centerLat * Math.PI / 180) / (s * Math.PI / 180);
  };
  /* 距離 [km] -> 画面上の px (中心緯度基準) */
  Projection.prototype.kmToPixels = function (km) { return km / this.kmPerPixel(); };

  Projection.prototype.panByPixels = function (dx, dy) {
    var s = this.scale();
    this.centerLon -= dx / s * 180 / Math.PI;
    var my = this.mercY(this.centerLat) + dy / s;
    this.centerLat = Math.max(15, Math.min(50, this.invMercY(my)));
    this.centerLon = Math.max(115, Math.min(160, this.centerLon));
  };

  /* 指定した画面座標を固定してズームする */
  Projection.prototype.zoomAt = function (factor, px, py) {
    var before = this.unproject(px, py);
    this.zoom = Math.max(0.6, Math.min(60, this.zoom * factor));
    var after = this.unproject(px, py);
    this.centerLat += before[0] - after[0];
    this.centerLon += before[1] - after[1];
    this.centerLat = Math.max(15, Math.min(50, this.centerLat));
    this.centerLon = Math.max(115, Math.min(160, this.centerLon));
  };

  /* 指定範囲が収まるようにビューを合わせる */
  Projection.prototype.fitBounds = function (latMin, lonMin, latMax, lonMax, pad) {
    pad = pad || 1.15;
    this.centerLat = (latMin + latMax) / 2;
    this.centerLon = (lonMin + lonMax) / 2;
    var s = this.scale();
    var needX = (lonMax - lonMin) * Math.PI / 180 * this.baseScale;
    var needY = (this.mercY(latMax) - this.mercY(latMin)) * this.baseScale;
    var z = Math.min(this.width / (needX * pad), this.height / (needY * pad));
    this.zoom = Math.max(0.6, Math.min(60, z));
  };

  global.Projection = Projection;
})(window);
