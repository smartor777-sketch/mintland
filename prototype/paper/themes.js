/* Mintland · карты: таблицы тем.
 *
 * Здесь нет логики рисования — только данные. Движок (engine.js) читает
 * палитру, озёра, подписи и стартовые значения ползунков. Новая карта должна
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
      paper: '#d6c4a0',
      paperLight: '#efe1bb',
      paperEdge: 'rgba(80, 55, 30, 0.20)',
      sea: '#cdbb96',
      seaLine: 'rgba(96, 73, 43, 0.22)',
      land: '#efe1bb',
      landAlt: '#e9d9b1',
      ink: '#5a4630',
      inkSoft: 'rgba(90, 70, 48, 0.50)',
      road: 'rgba(90, 70, 48, 0.55)',
      tree: '#78855a',
      treeLight: '#8f9b68',
      treeDark: '#59663c',
      wallLeft: '#cdb08a',
      wallRight: '#bd9b73',
      roofLeft: '#9c5a42',
      roofRight: '#854a35',
      roofAltLeft: '#8f6a4a',
      roofAltRight: '#79563b',
      stone: '#c9b58c',
      stoneDark: '#b09a72',
      mountain: '#bda87f',
      mountainDark: '#8d7a59',
      wood: '#8f6a44',
      shadow: 'rgba(72, 52, 29, 0.16)',
      clearing: 'rgba(246, 236, 210, 0.55)',
      clearingLine: 'rgba(90, 70, 48, 0.22)'
    },
    defaults: {
      variant: 'worldmap',
      density: 0.70,
      forest: 0.60,
      roads: 0.70,
      units: 3,
      cap30: true
    },
    // Озёра: координаты и радиусы — доли от размера экрана. Так карта
    // остаётся одинаковой на любом разрешении.
    lakes: [
      { x: 0.17, y: 0.16, rx: 0.085, ry: 0.055, seed: 11, name: 'LACUS NIGER' },
      { x: 0.84, y: 0.79, rx: 0.062, ry: 0.038, seed: 29, name: 'LACUS MINOR' },
      { x: 0.67, y: 0.29, rx: 0.042, ry: 0.025, seed: 47 }
    ],
    // Подписи: рисуются тушью, как на старых картах. Место под заголовок
    // резервируется, чтобы его не закрыли горы или лес.
    labels: [
      { x: 0.50, y: 0.10, text: 'TERRA INCOGNITA', size: 16, track: 4.0 }
    ],
    compass: { x: 0.93, y: 0.88, r: 26 },
    roads: {
      maxCities: 6,
      // Минимальное расстояние между городами — доля от меньшей стороны.
      citySpacing: 0.30
    },
    objects: {
      // Насколько близко к иконке нельзя ставить дом или дерево.
      margin: 20
    }
  };

  global.PaperThemes = {
    worldmap: worldmap
  };
})(window);
