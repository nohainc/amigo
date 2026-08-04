export interface WeatherForecast {
  date: string;
  tempMax: number;
  tempMin: number;
  precipProb: number;
  windSpeedMax: number;
  weatherCode: number;
}

export async function fetchBratislavaTomorrowWeather(): Promise<WeatherForecast> {
  const url =
    "https://api.open-meteo.com/v1/forecast?latitude=48.1482&longitude=17.1067&daily=weathercode,temperature_2m_max,temperature_2m_min,precipitation_probability_max,windspeed_10m_max&timezone=Europe%2FBratislava";

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Open-Meteo API failed: ${response.statusText}`);
  }

  const data = (await response.json()) as any;
  if (!data.daily || !data.daily.time || data.daily.time.length < 2) {
    throw new Error("Invalid response structure from Open-Meteo API");
  }

  // Index 1 corresponds to tomorrow's daily data
  return {
    date: data.daily.time[1],
    tempMax: data.daily.temperature_2m_max[1],
    tempMin: data.daily.temperature_2m_min[1],
    precipProb: data.daily.precipitation_probability_max[1],
    windSpeedMax: data.daily.windspeed_10m_max[1],
    weatherCode: data.daily.weathercode[1],
  };
}

export function getWeatherDescription(code: number): { text: string; emoji: string } {
  // WMO Weather interpretation codes (GY)
  switch (code) {
    case 0:
      return { text: "Ясно / Безхмарно", emoji: "☀️" };
    case 1:
      return { text: "Переважно ясно", emoji: "🌤️" };
    case 2:
      return { text: "Мінлива хмарність", emoji: "⛅" };
    case 3:
      return { text: "Хмарно", emoji: "☁️" };
    case 45:
    case 48:
      return { text: "Туман", emoji: "🌫️" };
    case 51:
    case 53:
      return { text: "Слабкий мряка", emoji: "🌧️" };
    case 55:
      return { text: "Інтенсивна мряка", emoji: "🌧️" };
    case 61:
      return { text: "Невеликий дощ", emoji: "🌧️" };
    case 63:
      return { text: "Помірний дощ", emoji: "🌧️" };
    case 65:
      return { text: "Сильний дощ", emoji: "🌊" };
    case 71:
    case 73:
    case 75:
      return { text: "Снігопад", emoji: "❄️" };
    case 80:
    case 81:
    case 82:
      return { text: "Злива", emoji: "🌧️" };
    case 95:
    case 96:
    case 99:
      return { text: "Гроза", emoji: "⛈️" };
    default:
      return { text: "Мінливі погодні умови", emoji: "🌈" };
  }
}

export function formatWeatherMessage(w: WeatherForecast): string {
  const { text, emoji } = getWeatherDescription(w.weatherCode);
  
  // Format date from YYYY-MM-DD to DD.MM.YYYY
  const parts = w.date.split("-");
  const formattedDate = parts.length === 3 ? `${parts[2]}.${parts[1]}.${parts[0]}` : w.date;

  return `✨ <b>Прогноз погоди у Братиславі на завтра (${formattedDate})</b> ${emoji}

🌡️ <b>Температура:</b> від <code>${Math.round(w.tempMin)}°C</code> до <code>${Math.round(w.tempMax)}°C</code>
📝 <b>Стан неба:</b> ${text}
🌧️ <b>Ймовірність опадів:</b> <code>${w.precipProb}%</code>
💨 <b>Макс. швидкість вітру:</b> <code>${w.windSpeedMax} км/год</code>

Гарного вечора та спокійної ночі! 🇸🇰🇺🇦`;
}
