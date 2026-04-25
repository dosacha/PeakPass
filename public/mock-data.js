// Mock data + mock API for PeakPass demo

window.MOCK_EVENTS = [
  {
    id: "evt_01J9KX4Q2PWV",
    title: "IU — HEREH World Tour in Seoul",
    description: "3시간 공연, 오프닝 게스트 포함. 전좌석 지정.",
    date: "2026-06-14T19:00:00+09:00",
    capacity: 15000,
    availableSeats: 4217,
    pricing: [
      { tier: "VIP",      tierId: "tier_vip",      price: 220000, seats: 800,  available: 42 },
      { tier: "R",        tierId: "tier_r",        price: 154000, seats: 3500, available: 318 },
      { tier: "S",        tierId: "tier_s",        price: 110000, seats: 6200, available: 1840 },
      { tier: "A",        tierId: "tier_a",        price: 77000,  seats: 4500, available: 2017 }
    ]
  },
  {
    id: "evt_01J9KX5D0M3C",
    title: "FC Seoul vs Ulsan HD — K리그 1",
    description: "상암 월드컵경기장. 원정 응원석 별도.",
    date: "2026-05-03T16:30:00+09:00",
    capacity: 66000,
    availableSeats: 21800,
    pricing: [
      { tier: "SKYBOX",   tierId: "tier_sky",      price: 180000, seats: 400,  available: 12 },
      { tier: "PREMIUM",  tierId: "tier_prm",      price: 80000,  seats: 6000, available: 2100 },
      { tier: "NORMAL",   tierId: "tier_nrm",      price: 35000,  seats: 45000, available: 18200 },
      { tier: "AWAY",     tierId: "tier_awy",      price: 30000,  seats: 4000, available: 1488 }
    ]
  },
  {
    id: "evt_01J9KX6A5F7H",
    title: "BIFAN 2026 — 개막작 + GV",
    description: "부천 CGV 소향. 감독 관객와의 대화 포함.",
    date: "2026-07-04T20:00:00+09:00",
    capacity: 820,
    availableSeats: 41,
    pricing: [
      { tier: "PRESS",    tierId: "tier_prs",      price: 0,      seats: 80,   available: 0 },
      { tier: "GENERAL",  tierId: "tier_gen",      price: 22000,  seats: 740,  available: 41 }
    ]
  }
];

window.SEED_USER_ID = "usr_01J9KX0SEEDA";

// Delay helper for mock mode
window.mockDelay = (min = 180, max = 420) =>
  new Promise(r => setTimeout(r, Math.random() * (max - min) + min));
