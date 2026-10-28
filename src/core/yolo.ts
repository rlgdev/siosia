// 2.8 (FR-304–306, V70): the YOLO section — special days around the year, each a "time" entry like
// Childcare (base "childcare": who offers Childcare offers them, the contract's Childcare rate prices
// them). `date` ("MM-DD") orders the list by the next occurrence; `when` is what the card says.
// The SQL migration appends the same entries (by id) to app_config.services — keep both in step.

import type { CatalogEntry } from "./types";

export const YOLO_SERVICES: CatalogEntry[] = [
  {
    "id": "yolo_halloween",
    "kind": "time",
    "section": "yolo",
    "base": "childcare",
    "date": "10-31",
    "when": {
      "en": "31 Oct",
      "pl": "31 paź"
    },
    "name": {
      "en": "Halloween",
      "pl": "Halloween"
    },
    "description": {
      "en": "Costumes, pumpkins, trick-or-treat round the block",
      "pl": "Przebrania, dynie i cukierek albo psikus po sąsiedztwie"
    },
    "icon": "🎃",
    "duration": {
      "default": 180,
      "min": 60,
      "max": 720,
      "step": 30
    },
    "price": null,
    "needsPlace": true,
    "enabled": true
  },
  {
    "id": "yolo_nicholas",
    "kind": "time",
    "section": "yolo",
    "base": "childcare",
    "date": "12-06",
    "when": {
      "en": "6 Dec",
      "pl": "6 gru"
    },
    "name": {
      "en": "St Nicholas' Day",
      "pl": "Mikołajki"
    },
    "description": {
      "en": "Gifts, a red hat and a visit from the saint",
      "pl": "Prezenty, czerwona czapka i wizyta Mikołaja"
    },
    "icon": "🎁",
    "duration": {
      "default": 180,
      "min": 60,
      "max": 720,
      "step": 30
    },
    "price": null,
    "needsPlace": true,
    "enabled": true
  },
  {
    "id": "yolo_christmas",
    "kind": "time",
    "section": "yolo",
    "base": "childcare",
    "date": "12-24",
    "when": {
      "en": "24 Dec",
      "pl": "24 gru"
    },
    "name": {
      "en": "Christmas",
      "pl": "Boże Narodzenie"
    },
    "description": {
      "en": "Baking, decorating the tree, kids busy while you cook",
      "pl": "Pieczenie, ubieranie choinki, dzieci zajęte, gdy gotujesz"
    },
    "icon": "🎄",
    "duration": {
      "default": 240,
      "min": 60,
      "max": 720,
      "step": 30
    },
    "price": null,
    "needsPlace": true,
    "enabled": true
  },
  {
    "id": "yolo_new_year",
    "kind": "time",
    "section": "yolo",
    "base": "childcare",
    "date": "12-31",
    "when": {
      "en": "31 Dec",
      "pl": "31 gru"
    },
    "name": {
      "en": "New Year's Eve",
      "pl": "Sylwester"
    },
    "description": {
      "en": "You celebrate, the kids watch the fireworks and sleep",
      "pl": "Ty świętujesz, dzieci oglądają fajerwerki i śpią"
    },
    "icon": "🎆",
    "duration": {
      "default": 360,
      "min": 120,
      "max": 900,
      "step": 30
    },
    "price": null,
    "needsPlace": true,
    "enabled": true
  },
  {
    "id": "yolo_winter",
    "kind": "time",
    "section": "yolo",
    "base": "childcare",
    "date": "01-20",
    "when": {
      "en": "Jan–Feb",
      "pl": "sty–lut"
    },
    "name": {
      "en": "Winter holidays",
      "pl": "Ferie zimowe"
    },
    "description": {
      "en": "Sledging, snowmen and hot cocoa",
      "pl": "Sanki, bałwany i gorące kakao"
    },
    "icon": "❄️",
    "duration": {
      "default": 480,
      "min": 120,
      "max": 720,
      "step": 30
    },
    "price": null,
    "needsPlace": true,
    "enabled": true
  },
  {
    "id": "yolo_date_night",
    "kind": "time",
    "section": "yolo",
    "base": "childcare",
    "date": "02-14",
    "when": {
      "en": "14 Feb",
      "pl": "14 lut"
    },
    "name": {
      "en": "Date night",
      "pl": "Randka we dwoje"
    },
    "description": {
      "en": "Valentine's or any evening just for the two of you",
      "pl": "Walentynki albo każdy wieczór tylko dla was"
    },
    "icon": "💝",
    "duration": {
      "default": 240,
      "min": 60,
      "max": 600,
      "step": 30
    },
    "price": null,
    "needsPlace": true,
    "enabled": true
  },
  {
    "id": "yolo_carnival",
    "kind": "time",
    "section": "yolo",
    "base": "childcare",
    "date": "02-10",
    "when": {
      "en": "Feb",
      "pl": "luty"
    },
    "name": {
      "en": "Carnival party",
      "pl": "Bal karnawałowy"
    },
    "description": {
      "en": "Fancy dress, masks and doughnuts",
      "pl": "Przebrania, maski i pączki"
    },
    "icon": "🎭",
    "duration": {
      "default": 180,
      "min": 60,
      "max": 720,
      "step": 30
    },
    "price": null,
    "needsPlace": true,
    "enabled": true
  },
  {
    "id": "yolo_easter",
    "kind": "time",
    "section": "yolo",
    "base": "childcare",
    "date": "04-01",
    "when": {
      "en": "Spring",
      "pl": "wiosna"
    },
    "name": {
      "en": "Easter",
      "pl": "Wielkanoc"
    },
    "description": {
      "en": "Painting eggs, the Easter basket, the egg hunt",
      "pl": "Malowanie pisanek, święconka i szukanie zajączka"
    },
    "icon": "🥚",
    "duration": {
      "default": 180,
      "min": 60,
      "max": 720,
      "step": 30
    },
    "price": null,
    "needsPlace": true,
    "enabled": true
  },
  {
    "id": "yolo_childrens_day",
    "kind": "time",
    "section": "yolo",
    "base": "childcare",
    "date": "06-01",
    "when": {
      "en": "1 Jun",
      "pl": "1 cze"
    },
    "name": {
      "en": "Children's Day",
      "pl": "Dzień Dziecka"
    },
    "description": {
      "en": "Balloons, games and the kids' own day out",
      "pl": "Balony, zabawy i dzień tylko dla dzieci"
    },
    "icon": "🎈",
    "duration": {
      "default": 180,
      "min": 60,
      "max": 720,
      "step": 30
    },
    "price": null,
    "needsPlace": true,
    "enabled": true
  },
  {
    "id": "yolo_summer",
    "kind": "time",
    "section": "yolo",
    "base": "childcare",
    "date": "07-01",
    "when": {
      "en": "Jul–Aug",
      "pl": "lip–sie"
    },
    "name": {
      "en": "Summer holidays",
      "pl": "Wakacje"
    },
    "description": {
      "en": "Lake, park and ice cream days while school is out",
      "pl": "Jezioro, park i lody, gdy szkoła ma przerwę"
    },
    "icon": "🏖️",
    "duration": {
      "default": 480,
      "min": 120,
      "max": 720,
      "step": 30
    },
    "price": null,
    "needsPlace": true,
    "enabled": true
  },
  {
    "id": "yolo_back_to_school",
    "kind": "time",
    "section": "yolo",
    "base": "childcare",
    "date": "09-01",
    "when": {
      "en": "1 Sep",
      "pl": "1 wrz"
    },
    "name": {
      "en": "Back to school",
      "pl": "Powrót do szkoły"
    },
    "description": {
      "en": "School supplies, the first day and the first homework",
      "pl": "Wyprawka, pierwszy dzień i pierwsze lekcje"
    },
    "icon": "🎒",
    "duration": {
      "default": 120,
      "min": 60,
      "max": 480,
      "step": 30
    },
    "price": null,
    "needsPlace": true,
    "enabled": true
  },
  {
    "id": "yolo_birthday",
    "kind": "time",
    "section": "yolo",
    "base": "childcare",
    "date": null,
    "when": {
      "en": "Any time",
      "pl": "kiedy chcesz"
    },
    "name": {
      "en": "Birthday party",
      "pl": "Urodziny"
    },
    "description": {
      "en": "Cake, candles and a room full of guests",
      "pl": "Tort, świeczki i pokój pełen gości"
    },
    "icon": "🎂",
    "duration": {
      "default": 180,
      "min": 60,
      "max": 720,
      "step": 30
    },
    "price": null,
    "needsPlace": true,
    "enabled": true
  },
  {
    "id": "yolo_party",
    "kind": "time",
    "section": "yolo",
    "base": "childcare",
    "date": null,
    "when": {
      "en": "Any time",
      "pl": "kiedy chcesz"
    },
    "name": {
      "en": "Kids' party",
      "pl": "Impreza dla dzieci"
    },
    "description": {
      "en": "Music, dancing and games for a crowd of kids",
      "pl": "Muzyka, tańce i zabawy dla gromadki dzieci"
    },
    "icon": "🎉",
    "duration": {
      "default": 180,
      "min": 60,
      "max": 720,
      "step": 30
    },
    "price": null,
    "needsPlace": true,
    "enabled": true
  },
  {
    "id": "yolo_sleepover",
    "kind": "time",
    "section": "yolo",
    "base": "childcare",
    "date": null,
    "when": {
      "en": "Any time",
      "pl": "kiedy chcesz"
    },
    "name": {
      "en": "Sleepover",
      "pl": "Piżama party"
    },
    "description": {
      "en": "Pyjamas, a film, stories and lights out",
      "pl": "Piżamy, film, bajki i gasimy światło"
    },
    "icon": "🌙",
    "duration": {
      "default": 720,
      "min": 240,
      "max": 1440,
      "step": 30
    },
    "price": null,
    "needsPlace": true,
    "enabled": true
  },
  {
    "id": "yolo_wedding",
    "kind": "time",
    "section": "yolo",
    "base": "childcare",
    "date": null,
    "when": {
      "en": "Any time",
      "pl": "kiedy chcesz"
    },
    "name": {
      "en": "Wedding & family do",
      "pl": "Wesele i rodzinna uroczystość"
    },
    "description": {
      "en": "The grown-ups celebrate, the kids are looked after",
      "pl": "Dorośli świętują, dzieci są pod opieką"
    },
    "icon": "💍",
    "duration": {
      "default": 480,
      "min": 120,
      "max": 900,
      "step": 30
    },
    "price": null,
    "needsPlace": true,
    "enabled": true
  }
];
