export interface RewardDriverEntry {
  driverId: string;
  rewardRupees: number;
  redAlertAt: Date;
  movedOutAt: Date;
}

export interface RewardSettlement {
  drivers: RewardDriverEntry[];
  rewardsSubtotal: number;
  distanceKm: number;
  perKmRate: number;
  distanceFee: number;
  platformRate: number;
  platformCharge: number;
  complianceFee: number;
  totalPayable: number;
}

interface SettlementInput {
  tripId: string;
  distanceMeters: number;
  driverCount?: number;
  perKmRate?: number;
  platformRate?: number;
  complianceFee?: number;
}

function hashSeed(seedText: string): number {
  let hash = 2166136261;
  for (let index = 0; index < seedText.length; index++) {
    hash ^= seedText.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state += 0x6d2b79f5;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomInt(rand: () => number, min: number, max: number): number {
  return Math.floor(rand() * (max - min + 1)) + min;
}

export function buildRewardsSettlement(input: SettlementInput): RewardSettlement {
  const driverCount = input.driverCount ?? 15;
  const perKmRate = input.perKmRate ?? 12;
  const platformRate = input.platformRate ?? 0.08;
  const complianceFee = input.complianceFee ?? 249;

  const seed = hashSeed(`${input.tripId}:${Math.round(input.distanceMeters)}`);
  const rand = mulberry32(seed);
  const baseTime = new Date();

  const drivers: RewardDriverEntry[] = [];
  for (let index = 0; index < driverCount; index++) {
    const driverSuffix = String(randomInt(rand, 100, 999));
    const driverId = `DRV-${String(index + 1).padStart(2, '0')}-${driverSuffix}`;

    const alertOffsetMin = randomInt(rand, 6, 38);
    const redZoneDurationMin = randomInt(rand, 2, 11);
    const redAlertAt = new Date(baseTime.getTime() - alertOffsetMin * 60_000);
    const movedOutAt = new Date(redAlertAt.getTime() + redZoneDurationMin * 60_000);
    const rewardRupees = randomInt(rand, 100, 700);

    drivers.push({
      driverId,
      rewardRupees,
      redAlertAt,
      movedOutAt,
    });
  }

  drivers.sort((a, b) => a.redAlertAt.getTime() - b.redAlertAt.getTime());

  const rewardsSubtotal = drivers.reduce((sum, row) => sum + row.rewardRupees, 0);
  const distanceKm = Number((Math.max(0, input.distanceMeters) / 1000).toFixed(1));
  const distanceFee = Math.round(distanceKm * perKmRate);
  const platformCharge = Math.round((rewardsSubtotal + distanceFee) * platformRate);
  const totalPayable = rewardsSubtotal + distanceFee + platformCharge + complianceFee;

  return {
    drivers,
    rewardsSubtotal,
    distanceKm,
    perKmRate,
    distanceFee,
    platformRate,
    platformCharge,
    complianceFee,
    totalPayable,
  };
}