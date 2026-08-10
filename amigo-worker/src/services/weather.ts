export interface CityConfig {
  nameUk: string;
  lat: number;
  lon: number;
  countryUk: string;
  flag: string;
}

export const CITIES: CityConfig[] = [
  { nameUk: "Братислава", lat: 48.1482, lon: 17.1067, countryUk: "Словаччина", flag: "🇸🇰" },
  { nameUk: "Кошице", lat: 48.7164, lon: 21.2611, countryUk: "Словаччина", flag: "🇸🇰" },
  { nameUk: "Прешов", lat: 48.9984, lon: 21.2408, countryUk: "Словаччина", flag: "🇸🇰" },
  { nameUk: "Жиліна", lat: 49.2232, lon: 18.7408, countryUk: "Словаччина", flag: "🇸🇰" },
  { nameUk: "Банська Бистриця", lat: 48.7350, lon: 19.1453, countryUk: "Словаччина", flag: "🇸🇰" },
  { nameUk: "Трнава", lat: 48.3775, lon: 17.5883, countryUk: "Словаччина", flag: "🇸🇰" },
  { nameUk: "Відень", lat: 48.2082, lon: 16.3738, countryUk: "Австрія", flag: "🇦🇹" },
];

export interface CityWeatherForecast {
  city: CityConfig;
  days: DailyWeatherForecast[];
}

export interface DailyWeatherForecast {
  date: string;
  tempMax: number;
  tempMin: number;
  precipProb: number;
  windSpeedMax: number;
  weatherCode: number;
}

import { trackedFetch } from "../utils/tracker";

export async function fetchCityWeather(city: CityConfig): Promise<CityWeatherForecast> {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${city.lat}&longitude=${city.lon}&daily=weathercode,temperature_2m_max,temperature_2m_min,precipitation_probability_max,windspeed_10m_max&timezone=auto`;

  const response = await trackedFetch(url);
  if (!response.ok) {
    throw new Error(`Open-Meteo API failed for ${city.nameUk}: ${response.statusText}`);
  }

  const data = (await response.json()) as any;
  if (!data.daily || !data.daily.time || data.daily.time.length < 3) {
    throw new Error(`Invalid response structure from Open-Meteo API for ${city.nameUk}`);
  }

  return {
    city,
    days: [0, 1, 2].map((index) => ({
      date: data.daily.time[index],
      tempMax: data.daily.temperature_2m_max[index],
      tempMin: data.daily.temperature_2m_min[index],
      precipProb: data.daily.precipitation_probability_max[index],
      windSpeedMax: data.daily.windspeed_10m_max[index],
      weatherCode: data.daily.weathercode[index],
    })),
  };
}

export async function fetchAllCitiesWeather(): Promise<CityWeatherForecast[]> {
  const results = await Promise.allSettled(CITIES.map((city) => fetchCityWeather(city)));
  const forecasts: CityWeatherForecast[] = [];
  const failures: string[] = [];

  results.forEach((result, index) => {
    if (result.status === "fulfilled") {
      forecasts.push(result.value);
      return;
    }

    const city = CITIES[index];
    const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
    failures.push(`${city.nameUk}: ${reason}`);
  });

  if (failures.length > 0) {
    console.warn(`Weather forecast skipped ${failures.length} city/cities: ${failures.join("; ")}`);
  }

  if (forecasts.length === 0) {
    throw new Error(`Failed to fetch weather for all cities: ${failures.join("; ")}`);
  }

  return forecasts;
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
    "Січень", "Лютий", "Березень", "Квітень", "Травень", "Червень",
    "Липень", "Серпень", "Вересень", "Жовтень", "Листопад", "Грудень"
  ];

  const firstDate = forecasts[0].days[0]?.date || "";
  const parts = firstDate.split("-");
  let monthHeader = firstDate;
  if (parts.length === 3) {
    const monthIdx = parseInt(parts[1], 10) - 1;
    if (monthIdx >= 0 && monthIdx < 12) {
      monthHeader = ukrainianMonths[monthIdx];
    }
  }

  let msg = `🌤️ <b><u>${monthHeader}</u></b>\n\n`;

  for (const forecast of forecasts) {
    msg += `${forecast.city.flag} <b>${forecast.city.nameUk}</b>\n`;
    for (const day of forecast.days) {
      const emoji = getWeatherEmoji(day.weatherCode);
      const windMs = Math.round(day.windSpeedMax / 3.6);
      msg += `${formatDay(day.date)} - ${emoji} | ${Math.round(day.tempMin)}-${Math.round(day.tempMax)}°C | ${day.precipProb}% | ${windMs} м/с\n`;
    }
    msg += "\n";
  }

  msg += `ℹ️ <i>Формат: дата - стан погоди | мін-макс температура | макс. ймовірність опадів | макс. швидкість вітру</i>\n\n`;
  msg += `<i>Джерело даних: Open-Meteo</i>`;
  return msg;
}

function formatDay(date: string): string {
  const parts = date.split("-");
  if (parts.length !== 3) return date;
  return parts[2].padStart(2, "0");
}
