// Заглушка Tauri для разработки вёрстки в обычном браузере.
// Подменяет только транспорт — ipc.ts об этом не знает.
// В собранном приложении не подключается: main.tsx звёт её лишь когда Tauri нет.

import { EMPTY_FILTER, type Beatmap, type Collection, type Label } from './types';

const COVER = (set: number) => `https://assets.ppy.sh/beatmaps/${set}/covers/cover@2x.jpg`;

interface Seed {
  id: number;
  set: number;
  artist: string;
  title: string;
  version: string;
  /** Маппер. У каждой карты свой: правило «не повторять маппера» иначе нечем проверить. */
  by: string;
  stars: number;
  bpm: number;
  len: number;
  ar: number;
  mods: string[];
  skills: string[];
}

// Мод-тегов у карты обычно несколько — карта, годная под NM, часто годится
// и под HD. С одним тегом на карту генерация пула была бы невозможна.
const SEEDS: Seed[] = [
  { id: 1, set: 1084284, artist: 'Zutomayo', title: 'Kan Saete Kuyashiiwa', version: 'Rampage', by: 'Nathan', stars: 6.24, bpm: 190, len: 232, ar: 9.6, mods: ['NM', 'HD'], skills: ['stream', 'stamina'] },
  { id: 2, set: 1148951, artist: 'Shikata Akiko', title: 'Kokuu no Kyouen', version: 'Feast', by: 'Sotarks', stars: 6.81, bpm: 176, len: 301, ar: 9.4, mods: ['HD', 'HR'], skills: ['reading', 'stamina'] },
  { id: 3, set: 1521113, artist: 'REDALiCE', title: 'Mahoroba', version: 'Utopia', by: 'Mismagius', stars: 6.05, bpm: 200, len: 154, ar: 9.3, mods: ['HR', 'NM'], skills: ['jump', 'aim'] },
  { id: 4, set: 774965, artist: 'warcooler', title: 'Hyper Kinetic', version: 'Overdrive', by: 'Kalibe', stars: 5.42, bpm: 145, len: 118, ar: 9.0, mods: ['DT', 'NM'], skills: ['speed', 'alt'] },
  { id: 5, set: 1023011, artist: 'Camellia', title: 'Hellcrusher', version: 'Annihilation', by: 'Monstrata', stars: 7.12, bpm: 220, len: 268, ar: 9.8, mods: ['NM', 'TB'], skills: ['stream', 'consistency'] },
  { id: 6, set: 936891, artist: 'Umbrella', title: 'Ugoku, Ugoku', version: 'Motion', by: 'Ephemeral', stars: 5.88, bpm: 168, len: 142, ar: 9.2, mods: ['FM', 'HD'], skills: ['tech', 'finger control'] },
  { id: 7, set: 1195835, artist: 'Rapsodie', title: 'Sunset Drive', version: 'Cruise', by: 'Nifty', stars: 6.44, bpm: 182, len: 205, ar: 9.5, mods: ['NM', 'HR'], skills: ['aim', 'alt'] },
  { id: 8, set: 1305043, artist: 'YUC\'e', title: 'Future Cake', version: 'Sweet', by: 'Akitoshi', stars: 5.31, bpm: 174, len: 129, ar: 8.9, mods: ['NM', 'DT'], skills: ['jump'] },
  { id: 9, set: 1441077, artist: 'Kobaryo', title: 'Levitating', version: 'Ascend', by: 'Doormat', stars: 6.97, bpm: 195, len: 187, ar: 9.7, mods: ['HD', 'DT'], skills: ['stream', 'speed'] },
  { id: 10, set: 1013891, artist: 'Big Black', title: 'Baldnoise', version: 'Chaos', by: 'Gero', stars: 7.55, bpm: 210, len: 244, ar: 10.0, mods: ['TB', 'NM'], skills: ['tech', 'stamina', 'stream'] },
  { id: 11, set: 1112283, artist: 'Zenith', title: 'Aurora Skies', version: 'Dawn', by: 'Skystar', stars: 4.92, bpm: 160, len: 165, ar: 8.7, mods: ['NM', 'FM'], skills: ['reading'] },
  { id: 12, set: 1273412, artist: 'Freedom', title: 'Open Road', version: 'Highway', by: 'Lasse', stars: 6.18, bpm: 188, len: 198, ar: 9.4, mods: ['FM', 'HR'], skills: ['alt', 'consistency'] },
  { id: 13, set: 1189741, artist: 'Nekomata Master', title: 'Far East Nightbird', version: 'Kuroi Ushi', by: 'Kroytz', stars: 6.62, bpm: 172, len: 176, ar: 9.5, mods: ['HR', 'DT'], skills: ['aim', 'jump'] },
  { id: 14, set: 1329901, artist: 'DragonForce', title: 'Through the Fire', version: 'Flames', by: 'Halgoh', stars: 7.31, bpm: 200, len: 428, ar: 9.9, mods: ['DT', 'TB'], skills: ['stamina', 'stream'] },
  { id: 15, set: 1402387, artist: 'sakuzyo', title: 'Altale', version: 'Starlight', by: 'Fii', stars: 5.74, bpm: 128, len: 151, ar: 9.1, mods: ['NM', 'HD'], skills: ['reading', 'tech'] },
  { id: 16, set: 1476620, artist: 'Feint', title: 'Snake Eyes', version: 'Venom', by: 'Sing', stars: 6.36, bpm: 174, len: 213, ar: 9.4, mods: ['HD', 'FM'], skills: ['alt', 'speed'] },
  // Сложности одного набора с id 1 — на них видно схлопывание в одну строку.
  { id: 17, set: 1084284, artist: 'Zutomayo', title: 'Kan Saete Kuyashiiwa', version: 'Insane', by: 'Nathan', stars: 4.88, bpm: 190, len: 232, ar: 9.0, mods: ['NM'], skills: ['stream'] },
  { id: 18, set: 1084284, artist: 'Zutomayo', title: 'Kan Saete Kuyashiiwa', version: 'Hard', by: 'Nathan', stars: 3.61, bpm: 190, len: 232, ar: 8.4, mods: ['NM'], skills: ['alt'] },
  { id: 19, set: 1084284, artist: 'Zutomayo', title: 'Kan Saete Kuyashiiwa', version: 'Normal', by: 'Nathan', stars: 2.44, bpm: 190, len: 232, ar: 7.0, mods: ['NM'], skills: [] },
];

function toBeatmap(s: Seed, i: number): Beatmap {
  return {
    beatmapId: s.id,
    beatmapsetId: s.set,
    checksum: null,
    artist: s.artist,
    artistUnicode: null,
    title: s.title,
    titleUnicode: null,
    version: s.version,
    creator: s.by,
    creatorId: 100 + i,
    difficultyRating: s.stars,
    bpm: s.bpm,
    totalLength: s.len,
    hitLength: s.len - 10,
    cs: 4,
    ar: s.ar,
    accuracy: 9,
    drain: 5.5,
    countCircles: 900,
    countSliders: 300,
    countSpinners: 2,
    maxCombo: 1500,
    status: 'ranked',
    rankedDate: null,
    lastUpdated: null,
    tags: null,
    packTags: null,
    genreId: null,
    languageId: null,
    failtimes: null,
    coverPath: COVER(s.set),
    previewPath: null,
    note: null,
    isManual: false,
    isGone: false,
    addedAt: `2026-0${(i % 8) + 1}-1${i % 9}T10:00:00Z`,
    mods: s.mods as Beatmap['mods'],
    fmMods: [],
    skillsets: s.skills.map((k, n) => ({
      skillset: k as never,
      suggested: n === 0,
    })),
    labels: i % 3 === 0 ? [{ id: 1, name: 'проверено', color: '#7ED957' }] : [],
  };
}

const MAPS: Beatmap[] = SEEDS.map(toBeatmap);

const COLLECTIONS: Collection[] = [
  { id: 1, name: 'Осенний кубок', color: '#FF6FB1', icon: null, folderId: null, position: 0, isSmart: false, filter: null, count: 8, createdAt: '2026-03-01T00:00:00Z' },
  { id: 2, name: 'Стримовые', color: '#5BC8F5', icon: null, folderId: null, position: 1, isSmart: false, filter: null, count: 5, createdAt: '2026-04-01T00:00:00Z' },
  { id: 3, name: 'Свежие 6★+', color: '#FFD03B', icon: null, folderId: null, position: 2, isSmart: true, filter: { ...EMPTY_FILTER, stars: { min: 6, max: null } }, count: 7, createdAt: '2026-05-01T00:00:00Z' },
];

const LABELS: Label[] = [
  { id: 1, name: 'проверено', color: '#7ED957' },
  { id: 2, name: 'спорная', color: '#FFD03B' },
  { id: 3, name: 'фан', color: '#C77DFF' },
];

export { MAPS, COLLECTIONS, LABELS };
