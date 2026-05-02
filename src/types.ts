export interface SerpResult {
  position: number;
  name: string;
  url: string;
  email: string;
  phone: string;
  snippet: string;
}

export interface ScrapeResponse {
  id: string;
  query: string;
  timestamp: string;
  screenshotPath: string;
  csvPath: string;
  results: SerpResult[];
}
