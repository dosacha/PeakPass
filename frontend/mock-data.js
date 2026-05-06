window.MOCK_EVENTS = [
  {
    id: "evt_01J9KX4Q2PWV",
    name: "IU — HEREH World Tour in Seoul",
    description: "3시간 공연, 오프닝 게스트 포함. 전좌석 지정.",
    startsAt: "2026-06-14T19:00:00+09:00",
    totalSeats: 15000,
    availableSeats: 4217,
    pricing: [
      { name: "VIP",      tierId: "tier_vip",      price: 220000, seats: 800 },
      { name: "R",        tierId: "tier_r",        price: 154000, seats: 3500 },
      { name: "S",        tierId: "tier_s",        price: 110000, seats: 6200 },
      { name: "A",        tierId: "tier_a",        price: 77000,  seats: 4500 }
    ]
  },
  {
    id: "evt_01J9KX5D0M3C",
    name: "FC Seoul vs Ulsan HD — K리그 1",
    description: "상암 월드컵경기장. 원정 응원석 별도.",
    startsAt: "2026-05-03T16:30:00+09:00",
    totalSeats: 66000,
    availableSeats: 21800,
    pricing: [
      { name: "SKYBOX",   tierId: "tier_sky",      price: 180000, seats: 400 },
      { name: "PREMIUM",  tierId: "tier_prm",      price: 80000,  seats: 6000 },
      { name: "NORMAL",   tierId: "tier_nrm",      price: 35000,  seats: 45000 },
      { name: "AWAY",     tierId: "tier_awy",      price: 30000,  seats: 4000 }
    ]
  },
  {
    id: "evt_01J9KX6A5F7H",
    name: "BIFAN 2026 — 개막작 + GV",
    description: "부천 CGV 소향. 감독 관객와의 대화 포함.",
    startsAt: "2026-07-04T20:00:00+09:00",
    totalSeats: 820,
    availableSeats: 41,
    pricing: [
      { name: "PRESS",    tierId: "tier_prs",      price: 0,      seats: 80 },
      { name: "GENERAL",  tierId: "tier_gen",      price: 22000,  seats: 740 }
    ]
  }
];

window.SEED_USER_ID = "usr_01J9KX0SEEDA";

// Delay helper for mock mode
window.mockDelay = (min = 180, max = 420) =>
  new Promise(r => setTimeout(r, Math.random() * (max - min) + min));
