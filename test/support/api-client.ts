export interface ApiResponse<T = any> {
  status: number;
  body: T;
  /**
   * The response exactly as it came off the socket. The integrity suite scans
   * this rather than the parsed body: a leak could hide in a field name, a
   * nested object the parser flattens into a shape the test forgot to walk, or
   * an error message that echoed the price back.
   */
  raw: string;
}

/**
 * Deliberately thin. A client that knew the response shapes would drift from
 * the DTOs, and half the point of these suites is to catch exactly that drift.
 */
export class Api {
  constructor(
    private readonly baseUrl: string,
    private readonly token?: string,
  ) {}

  /** A second client for the same replica, speaking as a different player. */
  as(token: string): Api {
    return new Api(this.baseUrl, token);
  }

  get<T = any>(path: string): Promise<ApiResponse<T>> {
    return this.request<T>('GET', path);
  }

  post<T = any>(path: string, body?: unknown): Promise<ApiResponse<T>> {
    return this.request<T>('POST', path, body);
  }

  del<T = any>(path: string): Promise<ApiResponse<T>> {
    return this.request<T>('DELETE', path);
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<ApiResponse<T>> {
    const headers: Record<string, string> = {};
    // Only when there is one. Declaring a JSON content-type on a bodiless
    // request makes Fastify reject it with a 400 before the route is reached —
    // which is exactly what a real client would hit on DELETE.
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (this.token) headers.authorization = `Bearer ${this.token}`;

    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    const raw = await response.text();
    let parsed: unknown = raw;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Left as the raw string: a non-JSON body is itself worth asserting on.
    }

    return { status: response.status, body: parsed as T, raw };
  }
}
