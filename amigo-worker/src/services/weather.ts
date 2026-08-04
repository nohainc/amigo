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

export async function fetchCityTomorrowWeather(city: CityConfig): Promise<CityWeatherForecast> {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${city.lat}&longitude=${city.lon}&daily=weathercode,temperature_2m_max,temperature_2m_min,precipitation_probability_max,windspeed_10m_max&timezone=auto`;

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Open-Meteo API failed for ${city.nameUk}: ${response.statusText}`);
  }

  const data = (await response.json()) as any;
  if (!data.daily || !data.daily.time || data.daily.time.length < 2) {
    throw new Error(`Invalid response structure from Open-Meteo API for ${city.nameUk}`);
  }

  // Index 1 corresponds to tomorrow's daily data
  return {
    city,
    date: data.daily.time[1],
    tempMax: data.daily.temperature_2m_max[1],
    tempMin: data.daily.temperature_2m_min[1],
    precipProb: data.daily.precipitation_probability_max[1],
    windSpeedMax: data.daily.windspeed_10m_max[1],
    weatherCode: data.daily.weathercode[1],
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

  // Get tomorrow's date formatted (using first forecast)
  const parts = forecasts[0].date.split("-");
  const formattedDate = parts.length === 3 ? `${parts[2]}.${parts[1]}.${parts[0]}` : forecasts[0].date;

  let msg = `✨ <b>Прогноз погоди на завтра (${formattedDate})</b> 🌤️\n\n`;

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
      msg += `• <b>${f.city.nameUk}:</b> 🌡️ <code>${Math.round(f.tempMin)}°C</code>..<code>${Math.round(
        f.tempMax
      )}°C</code> | ${emoji} | 🌧️ <code>${f.precipProb}%</code> | 💨 <code>${Math.round(
        f.windSpeedMax
      )} км/г</code>\n`;
    }
    msg += `\n`;
  }

  msg += `Гарного вечора та спокійної ночі! 🇸🇰🇺🇦`;
  return msg;
}
