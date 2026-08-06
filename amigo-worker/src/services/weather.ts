export interface CityConfig {
  nameUk: string;
  lat: number;
  lon: number;
  countryUk: string;
  flag: string;
}

export const CITIES: CityConfig[] = [
  // Slovakia
  { nameUk: "Братислава", lat: 48.1482, lon: 17.1067, countryUk: "Словаччина", flag: "🇸🇰" },
  { nameUk: "Кошице", lat: 48.7164, lon: 21.2611, countryUk: "Словаччина", flag: "🇸🇰" },
  { nameUk: "Прешов", lat: 48.9984, lon: 21.2408, countryUk: "Словаччина", flag: "🇸🇰" },
  { nameUk: "Жиліна", lat: 49.2232, lon: 18.7408, countryUk: "Словаччина", flag: "🇸🇰" },
  { nameUk: "Банська Бистриця", lat: 48.7350, lon: 19.1453, countryUk: "Словаччина", flag: "🇸🇰" },
  { nameUk: "Трнава", lat: 48.3775, lon: 17.5883, countryUk: "Словаччина", flag: "🇸🇰" },
  // Ukraine
  { nameUk: "Київ", lat: 50.4501, lon: 30.5234, countryUk: "Україна", flag: "🇺🇦" },
  { nameUk: "Львів", lat: 49.8397, lon: 24.0297, countryUk: "Україна", flag: "🇺🇦" },
  // Austria
  { nameUk: "Відень", lat: 48.2082, lon: 16.3738, countryUk: "Австрія", flag: "🇦🇹" },
];

export interface CityWeatherForecast {
  city: CityConfig;
  date: string;
  tempMax: number;
  tempMin: number;
  precipProb: number;
  windSpeedMax: number;
  weatherCode: number;
}

import { trackedFetch } from "../utils/tracker";

export async function fetchCityTomorrowWeather(city: CityConfig): Promise<CityWeatherForecast> {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${city.lat}&longitude=${city.lon}&daily=weathercode,temperature_2m_max,temperature_2m_min,precipitation_probability_max,windspeed_10m_max&timezone=auto`;

  const response = await trackedFetch(url);
  if (!response.ok) {
    throw new Error(`Open-Meteo API failed for ${city.nameUk}: ${response.statusText}`);
  }

  const data = (await response.json()) as any;
  if (!data.daily || !data.daily.time || data.daily.time.length < 3) {
    throw new Error(`Invalid response structure from Open-Meteo API for ${city.nameUk}`);
  }

  // Index 2 corresponds to the day after tomorrow.
  return {
    city,
    date: data.daily.time[2],
    tempMax: data.daily.temperature_2m_max[2],
    tempMin: data.daily.temperature_2m_min[2],
    precipProb: data.daily.precipitation_probability_max[2],
    windSpeedMax: data.daily.windspeed_10m_max[2],
    weatherCode: data.daily.weathercode[2],
  };
}

export async function fetchAllCitiesWeather(): Promise<CityWeatherForecast[]> {
  const promises = CITIES.map((city) => fetchCityTomorrowWeather(city));
  return Promise.all(promises);
}

export function getWeatherEmoji(code: number): string {
  // Simple WMO code to emoji converter
  switch (code) {
    case 0:
      return "☀️";
    case 1:
      return "🌤️";
    case 2:
      return "⛅";
    case 3:
      return "☁️";
    case 45:
    case 48:
      return "🌫️";
    case 51:
    case 53:
    case 55:
    case 61:
    case 63:
    case 65:
    case 80:
    case 81:
    case 82:
      return "🌧️";
    case 71:
    case 73:
    case 75:
      return "❄️";
    case 95:
    case 96:
    case 99:
      return "⛈️";
    default:
      return "🌈";
  }
}

export function formatMultiCityWeatherMessage(forecasts: CityWeatherForecast[]): string {
  if (forecasts.length === 0) return "";

  const ukrainianMonths = [
    "січня", "лютого", "березня", "квітня", "травня", "червня",
    "липня", "серпня", "вересня", "жовтня", "листопада", "грудня"
  ];

  // Get target date formatted as "Day Month" in Ukrainian
  const parts = forecasts[0].date.split("-");
  let dateHeader = forecasts[0].date;
  if (parts.length === 3) {
    const day = parseInt(parts[2], 10);
    const monthIdx = parseInt(parts[1], 10) - 1;
    if (monthIdx >= 0 && monthIdx < 12) {
      dateHeader = `${day} ${ukrainianMonths[monthIdx]}`;
    }
  }

  let msg = `📅 <b><u>${dateHeader}</u></b> 🌤️\n\n`;

  // Group by country
  const groups: Record<string, { flag: string; list: CityWeatherForecast[] }> = {};
  for (const f of forecasts) {
    if (!groups[f.city.countryUk]) {
      groups[f.city.countryUk] = { flag: f.city.flag, list: [] };
    }
    groups[f.city.countryUk].list.push(f);
  }

  for (const [country, group] of Object.entries(groups)) {
    msg += `${group.flag} <b>${country}:</b>\n`;
    for (const f of group.list) {
      const emoji = getWeatherEmoji(f.weatherCode);
      const windMs = Math.round(f.windSpeedMax / 3.6);
      msg += `<b>${f.city.nameUk}:</b>\n${emoji} | ${Math.round(f.tempMin)}-${Math.round(f.tempMax)}°C | ${f.precipProb}% | ${windMs} м/с\n`;
    }
    msg += `\n`;
  }

  msg += `ℹ️ <i>Формат: стан погоди | мін-макс температура | макс. ймовірність опадів | макс. швидкість вітру</i>\n\n`;
  msg += `<i>Джерело даних: Open-Meteo</i>`;
  return msg;
}
