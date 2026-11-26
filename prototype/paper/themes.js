/* Mintland · карты: таблицы тем.
 *
 * Здесь нет логики рисования — только данные. Движок (engine.js) читает
 * палитру, озёра, реки и стартовые значения ползунков. Новая карта должна
 * добавляться сюда таблицей, а не копией страницы: это условие из
 * docs/PAPER.md, §10.
 *
 * Первая тема — «Старая карта» (worldmap). Остальные (nauticalmap, map,
 * citymap) появятся, когда будет готов движок и первая карта.
 */
(function (global) {
  'use strict';

  var worldmap = {
    id: 'worldmap',
    name: 'Старая карта',
    palette: {
      // Палитра снята с образца: тёплый пергамент и коричневая тушь.
      paper: '#dbc392',
      paperLight: '#e7d7ae',
      paperEdge: 'rgba(80, 55, 30, 0.26)',
      sea: '#d2bd93',
      seaLine: 'rgba(70, 51, 29, 0.30)',
      ink: '#5a4322',
      inkSoft: 'rgba(90, 67, 34, 0.55)',
      road: 'rgba(90, 67, 34, 0.62)',
      river: 'rgba(84, 108, 125, 0.58)',
      tree: '#cdb88f',
      treeLight: '#b6a073',
      wallLeft: '#e2d0a6',
      wallRight: '#d9c399',
      roofLeft: '#d9c399',
      roofRight: '#c9b287',
      stone: '#e2d0a6',
      stoneDark: '#d2bd93',
      mountain: '#e2d0a6',
      mountainDark: '#c9b287',
      wood: '#cdb88f',
      shadow: 'rgba(70, 51, 29, 0.08)',
      clearing: 'rgba(228, 210, 168, 0.55)',
      clearingLine: 'rgba(70, 51, 29, 0.20)'
    },
    defaults: {
      variant: 'worldmap',
      density: 0.70,
      forest: 0.65,
      roads: 0.70,
      units: 3,
      cap30: true
    },
    // Озёра: координаты и радиусы — доли от размера экрана. Так карта
    // остаётся одинаковой на любом разрешении.
    lakes: [
      { x: 0.18, y: 0.17, rx: 0.070, ry: 0.045, seed: 11 },
      { x: 0.83, y: 0.80, rx: 0.055, ry: 0.032, seed: 29 }
    ],
    // Река: ломаная в долях экрана, движок сглаживает её сам.
    rivers: [
      { points: [[-0.02, 0.02], [0.04, 0.09], [0.10, 0.15],
                 [0.15, 0.28], [0.20, 0.42], [0.24, 0.57]] }
    ],
    // Названия городов берутся по очереди; подписи рисуются у самих
    // городов, поэтому не нужно угадывать место на пустом пергаменте.
    cityNames: ['Silvaria', 'Porta Nova', 'Ora Aurea', 'Mons Albus',
                'Vallis Aurea', 'Ripa Nova'],
    // Отдельные подписи областей.
    labels: [
      { x: 0.83, y: 0.90, text: 'Promontorium', size: 13 }
    ],
    roads: {
      maxCities: 5,
      // Минимальное расстояние между городами — доля от меньшей стороны.
      citySpacing: 0.32
    },
    objects: {
      // Насколько близко к иконке нельзя ставить дом или дерево.
      margin: 14
    }
  };

  global.PaperThemes = {
    worldmap: worldmap
  };
})(window);
