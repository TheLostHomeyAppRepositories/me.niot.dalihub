import http from 'http';

// DALI Arc Power <-> Percent 변환
// DALI 표준 로그 커브 기반

const DALI_MAX_ARC = 254;

/**
 * DALI Arc 값을 퍼센트로 변환
 * @param arc - DALI arc 값 (1-254, 0은 OFF)
 * @returns 밝기 퍼센트 (0.1 ~ 100)
 */
export function arcToPercent(arc: number): number {
  if (arc <= 0) return 0;
  if (arc > DALI_MAX_ARC) arc = DALI_MAX_ARC;

  // DALI 표준 공식: percent = 10^((arc - 254) * 3 / 253)
  const percent = 10 ** (((arc - 254) * 3) / 253) * 100;
  return Math.round(percent * 100) / 100; // 소수점 2자리
}

/**
 * 퍼센트를 DALI Arc 값으로 변환
 * @param percent - 밝기 퍼센트 (0-100)
 * @returns DALI arc 값 (0-254)
 */
export function percentToArc(percent: number): number {
  if (percent <= 0) return 0;
  if (percent > 100) percent = 100;

  // 역공식: arc = 253/3 * log10(percent/100) + 254
  const arc = (253 / 3) * Math.log10(percent / 100) + 254;
  return Math.round(arc);
}

/**
 * DALI Arc 값을 Homey dim 값(0-1)으로 변환
 *
 * 켜져 있는 한(arc 1 이상) 최소 0.01(1%)을 보장한다.
 * 로그 커브상 arc 1~84는 1% 미만이라 그대로 넣으면 Homey UI에
 * 0%(꺼진 것처럼)로 표시되기 때문.
 * @param arc - DALI arc 값 (0-254)
 * @returns Homey dim 값 (0-1)
 */
export function arcToDim(arc: number): number {
  if (arc <= 0) return 0;
  return Math.max(0.01, arcToPercent(arc) / 100);
}

export interface DaliGear {
  busId: number;
  address: number;
  level: number;
  lastUpdated: string;
  deviceTypes?: number[];
  name: string;
  // DT8 colour properties
  colourTypeFeatures?: number;
  colourStatus?: number;
  numberOfPrimaries?: number;
  tcCoolest?: number;
  tcWarmest?: number;
  tcCurrent?: number;
}

export interface DaliGroup {
  busId: number;
  groupId: number;
  level: number;
  lastSetLevel: number | null;
  memberCount: number;
  name: string;
  members: Array<{
    address: number;
    level: number;
  }>;
}

export interface DaliControlDeviceInstance {
  index: number;
  type: 1 | 3 | 4;
  name: string;
  luxValue?: number;
  luxUpdated?: string;
  illuminance?: number;
  illuminanceUpdated?: string;
}

export interface DaliControlDevice {
  busId: number;
  address: number;
  instances: DaliControlDeviceInstance[];
}

export interface DaliState {
  gears: DaliGear[];
  groups: DaliGroup[];
  controlDevices: DaliControlDevice[];
}

export type DaliEvent =
  | { type: 'gear.changed'; busId: number; address: number; level: number; source?: string; command?: string }
  | { type: 'group.changed'; busId: number; groupId: number; level: number; memberCount?: number; source?: string; command?: string }
  | { type: 'push-button.event'; busId: number; address: number; instanceIndex: number; eventName: string; eventCode: number }
  | { type: 'occupancy.event'; busId: number; address: number; instanceIndex: number; movement: boolean; occupancy: string; sensorType: string; eventCode: number }
  | { type: 'control-device.lux'; busId: number; address: number; instanceIndex: number; luxValue: number }
  | { type: 'control-device.illuminance'; busId: number; address: number; instanceIndex: number; illuminance: number };

export class DaliApiClient {
  private baseUrl: string;
  private log: (...args: unknown[]) => void;

  constructor(host: string, logger: (...args: unknown[]) => void) {
    // If host doesn't include port, add default port 3000
    const hostWithPort = host.includes(':') ? host : `${host}:3000`;
    this.baseUrl = `http://${hostWithPort}`;
    this.log = logger;
  }

  async getState(bus: number): Promise<DaliState> {
    return new Promise((resolve, reject) => {
      const url = `${this.baseUrl}/state?bus=${bus}`;
      this.log('Fetching state:', url);

      http.get(url, (res) => {
        let data = '';

        res.on('data', (chunk) => {
          data += chunk;
        });

        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            try {
              const state = JSON.parse(data);
              resolve(state);
            } catch (error) {
              reject(error);
            }
          } else {
            reject(new Error(`Request failed with status ${res.statusCode}: ${data}`));
          }
        });
      }).on('error', (error) => {
        reject(error);
      });
    });
  }

  async setLightPercent(busId: number, address: number, percent: number, fadeTime?: number): Promise<void> {
    this.log(`🔆 Set Light Percent - Bus ${busId}, Address ${address}, Percent ${percent}%${fadeTime !== undefined ? `, Fade Time ${fadeTime}` : ''}`);
    const body: Record<string, unknown> = {
      bus: busId,
      percent,
    };
    if (fadeTime !== undefined) {
      body.fadeTime = fadeTime;
    }
    return this.makePostRequest(`/dali/lights/${address}/percent`, body);
  }

  async setLightLevel(busId: number, address: number, level: number, fadeTime?: number): Promise<void> {
    this.log(`🔆 Set Light Level - Bus ${busId}, Address ${address}, Level ${level}${fadeTime !== undefined ? `, Fade Time ${fadeTime}` : ''}`);
    const body: Record<string, unknown> = {
      bus: busId,
      level,
    };
    if (fadeTime !== undefined) {
      body.fadeTime = fadeTime;
    }
    return this.makePostRequest(`/dali/lights/${address}/level`, body);
  }

  async setLightOn(busId: number, address: number): Promise<void> {
    this.log(`💡 Set Light ON - Bus ${busId}, Address ${address}`);
    return this.makePostRequest(`/dali/lights/${address}/on`, {
      bus: busId,
    });
  }

  async setLightOff(busId: number, address: number): Promise<void> {
    this.log(`🔌 Set Light OFF - Bus ${busId}, Address ${address}`);
    return this.makePostRequest(`/dali/lights/${address}/off`, {
      bus: busId,
    });
  }

  async setLightUp(busId: number, address: number): Promise<void> {
    this.log(`⬆️ Set Light UP - Bus ${busId}, Address ${address}`);
    return this.makePostRequest(`/dali/lights/${address}/up`, {
      bus: busId,
    });
  }

  async setLightDown(busId: number, address: number): Promise<void> {
    this.log(`⬇️ Set Light DOWN - Bus ${busId}, Address ${address}`);
    return this.makePostRequest(`/dali/lights/${address}/down`, {
      bus: busId,
    });
  }

  async setGroupPercent(busId: number, groupId: number, percent: number, fadeTime?: number): Promise<void> {
    this.log(`🔆 Set Group Percent - Bus ${busId}, Group ${groupId}, Percent ${percent}%${fadeTime !== undefined ? `, Fade Time ${fadeTime}` : ''}`);
    const body: Record<string, unknown> = {
      bus: busId,
      percent,
    };
    if (fadeTime !== undefined) {
      body.fadeTime = fadeTime;
    }
    return this.makePostRequest(`/dali/groups/${groupId}/percent`, body);
  }

  async setGroupLevel(busId: number, groupId: number, level: number, fadeTime?: number): Promise<void> {
    this.log(`🔆 Set Group Level - Bus ${busId}, Group ${groupId}, Level ${level}${fadeTime !== undefined ? `, Fade Time ${fadeTime}` : ''}`);
    const body: Record<string, unknown> = {
      bus: busId,
      level,
    };
    if (fadeTime !== undefined) {
      body.fadeTime = fadeTime;
    }
    return this.makePostRequest(`/dali/groups/${groupId}/level`, body);
  }

  async setGroupOn(busId: number, groupId: number): Promise<void> {
    this.log(`💡 Set Group ON - Bus ${busId}, Group ${groupId}`);
    return this.makePostRequest(`/dali/groups/${groupId}/on`, {
      bus: busId,
    });
  }

  async setGroupOff(busId: number, groupId: number): Promise<void> {
    this.log(`🔌 Set Group OFF - Bus ${busId}, Group ${groupId}`);
    return this.makePostRequest(`/dali/groups/${groupId}/off`, {
      bus: busId,
    });
  }

  async setGroupUp(busId: number, groupId: number): Promise<void> {
    this.log(`⬆️ Set Group UP - Bus ${busId}, Group ${groupId}`);
    return this.makePostRequest(`/dali/groups/${groupId}/up`, {
      bus: busId,
    });
  }

  async setGroupDown(busId: number, groupId: number): Promise<void> {
    this.log(`⬇️ Set Group DOWN - Bus ${busId}, Group ${groupId}`);
    return this.makePostRequest(`/dali/groups/${groupId}/down`, {
      bus: busId,
    });
  }

  async recallScene(
    busId: number,
    scene: number,
    targetType: 'address' | 'group' | 'broadcast',
    targetValue: number,
    fadeTime?: number,
  ): Promise<void> {
    this.log(`🎬 Recall Scene ${scene} - Bus ${busId}, Type ${targetType}, Value ${targetValue}${fadeTime !== undefined ? `, Fade Time ${fadeTime}` : ''}`);
    const body: Record<string, unknown> = { bus: busId };

    if (targetType === 'address') {
      body.targetType = 'address';
      body.targetValue = targetValue;
    } else if (targetType === 'group') {
      body.targetType = 'group';
      body.targetValue = targetValue;
    } else {
      body.targetType = 'broadcast';
    }

    if (fadeTime !== undefined) {
      body.fadeTime = fadeTime;
    }

    return this.makePostRequest(`/dali/scenes/${scene}/recall`, body);
  }

  async setGroupMaxLevel(busId: number, groupId: number, level: number): Promise<void> {
    this.log(`🔆 Set Group Max Level - Bus ${busId}, Group ${groupId}, Max Level ${level}`);
    return this.makePostRequest(`/dali/groups/${groupId}/set-max-level`, {
      bus: busId,
      level,
    });
  }

  async setGroupMaxLevelPercent(busId: number, groupId: number, percent: number): Promise<void> {
    this.log(`🔆 Set Group Max Level Percent - Bus ${busId}, Group ${groupId}, Max Percent ${percent}%`);
    return this.makePostRequest(`/dali/groups/${groupId}/set-max-level-percent`, {
      bus: busId,
      percent,
    });
  }

  async setLightMaxLevel(busId: number, address: number, level: number): Promise<void> {
    this.log(`🔆 Set Light Max Level - Bus ${busId}, Address ${address}, Max Level ${level}`);
    return this.makePostRequest(`/dali/lights/${address}/set-max-level`, {
      bus: busId,
      level,
    });
  }

  async setLightMaxLevelPercent(busId: number, address: number, percent: number): Promise<void> {
    this.log(`🔆 Set Light Max Level Percent - Bus ${busId}, Address ${address}, Max Percent ${percent}%`);
    return this.makePostRequest(`/dali/lights/${address}/set-max-level-percent`, {
      bus: busId,
      percent,
    });
  }

  // DT8 Colour Query Methods

  async getNumberOfPrimaries(busId: number, address: number): Promise<number> {
    this.log(`Get Number of Primaries - Bus ${busId}, Address ${address}`);
    const result = await this.makeGetRequest<{ numberOfPrimaries: number }>(`/dali/lights/${address}/primaries?bus=${busId}`);
    return result.numberOfPrimaries;
  }

  async getPrimaryLevels(busId: number, address: number): Promise<number[]> {
    this.log(`Get Primary Levels - Bus ${busId}, Address ${address}`);
    const result = await this.makeGetRequest<{ levels: number[] }>(`/dali/lights/${address}/primary-levels?bus=${busId}`);
    return result.levels;
  }

  // DT8 Colour Control Methods

  async setColourTemperatureMirek(busId: number, address: number, mirek: number): Promise<void> {
    this.log(`Set Colour Temperature - Bus ${busId}, Address ${address}, Mirek ${mirek}`);
    return this.makePostRequest(`/dali/lights/${address}/colour-temperature-mirek`, {
      bus: busId,
      mirek,
    });
  }

  async setColourTemperatureKelvin(busId: number, address: number, kelvin: number): Promise<void> {
    this.log(`Set Colour Temperature - Bus ${busId}, Address ${address}, Kelvin ${kelvin}`);
    return this.makePostRequest(`/dali/lights/${address}/colour-temperature`, {
      bus: busId,
      kelvin,
    });
  }

  async setRGB(busId: number, address: number, r: number, g: number, b: number): Promise<void> {
    this.log(`Set RGB - Bus ${busId}, Address ${address}, R ${r}, G ${g}, B ${b}`);
    return this.makePostRequest(`/dali/lights/${address}/rgb`, {
      bus: busId,
      r,
      g,
      b,
    });
  }

  async setRGBW(busId: number, address: number, r: number, g: number, b: number, w: number): Promise<void> {
    this.log(`Set RGBW - Bus ${busId}, Address ${address}, R ${r}, G ${g}, B ${b}, W ${w}`);
    return this.makePostRequest(`/dali/lights/${address}/rgbw`, {
      bus: busId,
      r,
      g,
      b,
      w,
    });
  }

  async setRGBWW(busId: number, address: number, r: number, g: number, b: number, ww: number, cw: number): Promise<void> {
    this.log(`Set RGBWW - Bus ${busId}, Address ${address}, R ${r}, G ${g}, B ${b}, WW ${ww}, CW ${cw}`);
    return this.makePostRequest(`/dali/lights/${address}/rgbww`, {
      bus: busId,
      r,
      g,
      b,
      ww,
      cw,
    });
  }

  async setPrimaryLevel(busId: number, address: number, channel: number, level: number): Promise<void> {
    this.log(`Set Primary Level - Bus ${busId}, Address ${address}, Channel ${channel}, Level ${level}`);
    return this.makePostRequest(`/dali/lights/${address}/primary/${channel}`, {
      bus: busId,
      level,
    });
  }

  // Fade Time Methods

  async setLightFadeTime(busId: number, address: number, fadeTime: number): Promise<void> {
    this.log(`Set Light Fade Time - Bus ${busId}, Address ${address}, Fade Time ${fadeTime}`);
    return this.makePostRequest(`/dali/lights/${address}/set-fade-time`, {
      bus: busId,
      fadeTime,
    });
  }

  async setGroupFadeTime(busId: number, groupId: number, fadeTime: number): Promise<void> {
    this.log(`Set Group Fade Time - Bus ${busId}, Group ${groupId}, Fade Time ${fadeTime}`);
    return this.makePostRequest(`/dali/groups/${groupId}/set-fade-time`, {
      bus: busId,
      fadeTime,
    });
  }

  async setAllFadeTime(busId: number, fadeTime: number): Promise<void> {
    this.log(`Set All Fade Time - Bus ${busId}, Fade Time ${fadeTime}`);
    return this.makePostRequest(`/dali/all/set-fade-time`, {
      bus: busId,
      fadeTime,
    });
  }

  private makeGetRequest<T>(path: string): Promise<T> {
    return new Promise((resolve, reject) => {
      const url = `${this.baseUrl}${path}`;
      this.log(`GET ${url}`);

      http.get(url, (res) => {
        let data = '';

        res.on('data', (chunk) => {
          data += chunk;
        });

        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            try {
              const result = JSON.parse(data) as T;
              resolve(result);
            } catch (error) {
              reject(new Error(`Failed to parse response: ${data}`));
            }
          } else {
            reject(new Error(`Request failed with status ${res.statusCode}: ${data}`));
          }
        });
      }).on('error', (error) => {
        reject(error);
      });
    });
  }

  private makePostRequest(path: string, body: Record<string, unknown>): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = new URL(path, this.baseUrl);
      const postData = JSON.stringify(body);

      const options = {
        hostname: url.hostname,
        port: url.port || 3000,
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData),
        },
      };

      this.log(`POST ${this.baseUrl}${options.path} body:`, body);

      const req = http.request(options, (res) => {
        let data = '';

        res.on('data', (chunk) => {
          data += chunk;
        });

        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            resolve();
          } else {
            reject(new Error(`Request failed with status ${res.statusCode}: ${data}`));
          }
        });
      });

      req.on('error', (error) => {
        reject(error);
      });

      req.write(postData);
      req.end();
    });
  }

}
