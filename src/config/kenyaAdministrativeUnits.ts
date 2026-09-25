/**
 * Supplied Kenya second-level administrative geography baseline.
 *
 * The 47 county identities/order remain owned exclusively by kenyaCounties.ts.
 * Each row below explicitly binds a supplied display name to that county code;
 * it is never inferred from the name. The user-facing product calls this level
 * "sub-county". These values are the supplied implementation baseline, not a
 * claim of a separately researched legal Gazette register.
 */
import { KENYA_COUNTIES, type KenyanCounty } from './kenyaCounties';

export interface KenyaAdministrativeUnit {
  id: string;
  countyCode: KenyanCounty['code'];
  name: string;
}

type CountyUnitGroup = readonly [KenyanCounty['code'], readonly string[]];

const COUNTY_UNIT_GROUPS: readonly CountyUnitGroup[] = [
  ['KE-01', ['Changamwe', 'Jomvu', 'Kisauni', 'Nyali', 'Likoni', 'Mvita']],
  ['KE-02', ['Msambweni', 'Lunga Lunga', 'Matuga', 'Kinango', 'Samburu East']],
  ['KE-03', ['Kilifi North', 'Kilifi South', 'Kaloleni', 'Rabai', 'Ganze', 'Malindi', 'Magarini', 'Magarini North', 'Magarini South']],
  ['KE-04', ['Garsen', 'Galole', 'Bura']],
  ['KE-05', ['Lamu East', 'Lamu West']],
  ['KE-06', ['Taveta', 'Wundanyi', 'Mwatate', 'Voi']],
  ['KE-07', ['Garissa Township', 'Balambala', 'Lagdera', 'Dadaab', 'Fafi', 'Ijara', 'Bothai']],
  ['KE-08', ['Wajir North', 'Wajir East', 'Tarbaj', 'Wajir West', 'Eldas', 'Wajir South']],
  ['KE-09', ['Mandera West', 'Banissa', 'Mandera North', 'Mandera South', 'Mandera East', 'Lafey']],
  ['KE-10', ['Moyale', 'North Horr', 'Saku', 'Laisamis', 'Illeret']],
  ['KE-11', ['Isiolo', 'Merti', 'Garbatulla']],
  ['KE-12', ['Igembe South', 'Igembe Central', 'Igembe North', 'Tigania West', 'Tigania East', 'North Imenti', 'Buuri', 'Central Imenti', 'South Imenti', 'Akachiu']],
  ['KE-13', ['Maara', 'Chuka/Igambang\'ombe', 'Tharaka', 'Mukothima']],
  ['KE-14', ['Manyatta', 'Runyenjes', 'Mbeere North', 'Mbeere South']],
  ['KE-15', ['Mwingi North', 'Mwingi West', 'Mwingi Central', 'Kitui West', 'Kitui Rural', 'Kitui Central', 'Kitui East', 'Kitui South']],
  ['KE-16', ['Masinga', 'Yatta', 'Kangundo', 'Matungulu', 'Kathiani', 'Mavoko', 'Machakos Town', 'Mwala', 'Ndithini']],
  ['KE-17', ['Mbooni', 'Kilome', 'Kaiti', 'Makueni', 'Kibwezi West', 'Kibwezi East']],
  ['KE-18', ['Kinangop', 'Kipipiri', 'Ol Kalou', 'Ol Jorok', 'Ndaragwa', 'Aberdares']],
  ['KE-19', ['Tetu', 'Kieni East', 'Kieni West', 'Mathira East', 'Mathira West', 'Othaya', 'Mukurweini', 'Nyeri Town']],
  ['KE-20', ['Mwea East', 'Mwea West', 'Gichugu', 'Ndidia', 'Kirinyaga Central', 'Kirinyaga East']],
  ['KE-21', ['Kangema', 'Mathioya', 'Kahuro', 'Kigumo', 'Maragua', 'Kandara', 'Gatanga', 'Murang\'a South']],
  ['KE-22', ['Gatundu South', 'Gatundu North', 'Juja', 'Thika Town', 'Ruiru', 'Githunguri', 'Kiambu', 'Kiambaa', 'Kabete', 'Kikuyu', 'Lari', 'Limuru']],
  ['KE-23', ['Turkana North', 'Turkana West', 'Turkana Central', 'Loima', 'Turkana South', 'Turkana East']],
  ['KE-24', ['Kapenguria', 'Sigor', 'Kacheliba', 'Pokot South']],
  ['KE-25', ['Samburu West', 'Samburu North', 'Samburu East']],
  ['KE-26', ['Cherangany', 'Endebess', 'Saboti', 'Kwanza', 'Kiminini']],
  ['KE-27', ['Soy', 'Turbo', 'Moiben', 'Ainabkoi', 'Kapseret', 'Kesses']],
  ['KE-28', ['Marakwet East', 'Marakwet West', 'Keiyo North', 'Keiyo South']],
  ['KE-29', ['Tinderet', 'Aldai', 'Nandi Hills', 'Chesumei', 'Emgwen', 'Mosop']],
  ['KE-30', ['Tiaty', 'Baringo North', 'Baringo Central', 'Baringo South', 'Mogotio', 'Eldama Ravine', 'Kolowa', 'Baringo West', 'Mukutani']],
  ['KE-31', ['Laikipia West', 'Laikipia East', 'Laikipia North']],
  ['KE-32', ['Molo', 'Njoro', 'Naivasha', 'Gilgil', 'Kuresoi South', 'Kuresoi North', 'Subukia', 'Rongai', 'Bahati', 'Nakuru Town West', 'Nakuru Town East']],
  ['KE-33', ['Kilgoris', 'Emurua Dikirr', 'Narok North', 'Narok East', 'Narok South', 'Narok West']],
  ['KE-34', ['Kajiado North', 'Kajiado Central', 'Kajiado East', 'Kajiado West', 'Kajiado South']],
  ['KE-35', ['Kipkelion East', 'Kipkelion West', 'Belgut', 'Ainamoi', 'Soin Sigowet', 'Bureti']],
  ['KE-36', ['Sotik', 'Chepalungu', 'Bomet East', 'Bomet Central', 'Konoin']],
  ['KE-37', ['Lugari', 'Likuyani', 'Malava', 'Lurambi', 'Navakholo', 'Mumias West', 'Mumias East', 'Matungu', 'Butere', 'Khwisero', 'Shinyalu', 'Ikolomani']],
  ['KE-38', ['Vihiga', 'Sabatia', 'Hamisi', 'Luanda', 'Emuhaya']],
  ['KE-39', ['Mount Elgon', 'Sirisia', 'Kabuchai', 'Bumula', 'Kanduyi', 'Webuye East', 'Webuye West', 'Kimilili', 'Tongaren']],
  ['KE-40', ['Teso North', 'Teso South', 'Nambale', 'Matayos', 'Butula', 'Funyula', 'Budalangi']],
  ['KE-41', ['Ugenya', 'Ugunja', 'Alego Usonga', 'Gem', 'Bondo', 'Rarieda', 'Siaya West']],
  ['KE-42', ['Kisumu East', 'Kisumu West', 'Kisumu Central', 'Seme', 'Nyando', 'Muhoroni', 'Nyakach', 'North East Kano']],
  ['KE-43', ['Kasipul', 'Kabondo Kasipul', 'Karachuonyo', 'Rangwe', 'Homa Bay Town', 'Ndhiwa', 'Ndhiwa East', 'Ndhiwa West', 'Suba North', 'Suba South']],
  ['KE-44', ['Rongo', 'Awendo', 'Suna South', 'Suna West', 'Uriri', 'Nyatike', 'Kuria West', 'Kuria East']],
  ['KE-45', ['Bonchari', 'South Mugirango', 'Bomachoge Borabu', 'Bobasi', 'Bomachoge Chache', 'Nyaribari Masaba', 'Nyaribari Chache', 'Kitutu Chache North', 'Kitutu Chache South']],
  ['KE-46', ['Kitutu Masaba', 'West Mugirango', 'North Mugirango', 'Borabu']],
  ['KE-47', ['Westlands', 'Dagoretti North', 'Dagoretti South', 'Lang\'ata', 'Kibra', 'Roysambu', 'Kasarani', 'Ruaraka', 'Embakasi South', 'Embakasi North', 'Embakasi Central', 'Embakasi East', 'Embakasi West', 'Makadara', 'Kamukunji', 'Starehe', 'Mathare']],
];

export const KENYA_ADMINISTRATIVE_UNITS: readonly KenyaAdministrativeUnit[] = COUNTY_UNIT_GROUPS.flatMap(([countyCode, names]) => names.map((name, index) => ({
  id: `${countyCode}-SC-${String(index + 1).padStart(2, '0')}`,
  countyCode,
  name,
})));

const unitMap = new Map(KENYA_ADMINISTRATIVE_UNITS.map(unit => [unit.id, unit]));
const unitIdByCountyAndName = new Map(KENYA_ADMINISTRATIVE_UNITS.map(unit => [
  `${unit.countyCode}\u0000${unit.name.toLocaleLowerCase('en')}`,
  unit.id,
]));

export function administrativeUnitsForCounty(countyName: string): readonly KenyaAdministrativeUnit[] {
  const county = KENYA_COUNTIES.find(item => item.name === countyName);
  return county ? KENYA_ADMINISTRATIVE_UNITS.filter(unit => unit.countyCode === county.code) : [];
}

export function resolveAdministrativeUnitId(countyName: string, unitId: unknown): string | null {
  if (typeof unitId !== 'string') return null;
  const county = KENYA_COUNTIES.find(item => item.name === countyName);
  const unit = unitMap.get(unitId);
  return county && unit?.countyCode === county.code ? unit.id : null;
}

export function administrativeUnitById(unitId: string | null | undefined): KenyaAdministrativeUnit | null {
  return unitId ? unitMap.get(unitId) ?? null : null;
}

export function administrativeUnitNameForCounty(countyName: string, unitId: string | null | undefined): string | null {
  if (!unitId) return null;
  const county = KENYA_COUNTIES.find(item => item.name === countyName);
  const unit = unitMap.get(unitId);
  return county && unit?.countyCode === county.code ? unit.name : null;
}

// Exported for tests/diagnostics; runtime submission resolution is ID-based.
export function findAdministrativeUnitIdByName(countyName: string, name: string): string | null {
  const county = KENYA_COUNTIES.find(item => item.name === countyName);
  return county ? unitIdByCountyAndName.get(`${county.code}\u0000${name.trim().toLocaleLowerCase('en')}`) ?? null : null;
}
