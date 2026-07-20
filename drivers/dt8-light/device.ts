import Homey from 'homey';
import {
  DaliGear, DaliState, DaliApiClient, arcToPercent, percentToArc, arcToDim,
} from '../../lib/dali-api';

interface DT8LightDriver extends Homey.Driver {
  triggerLevelChanged(device: Homey.Device, tokens: { level: number }): Promise<void>;
}

// Default colour temperature range if not provided by device
const DEFAULT_TC_WARMEST = 2700; // Kelvin
const DEFAULT_TC_COOLEST = 6500; // Kelvin

class DT8LightDevice extends Homey.Device {
  declare driver: DT8LightDriver;
  private busId!: number;
  private address!: number;
  private tcWarmest!: number;
  private tcCoolest!: number;
  private supportsTc!: boolean;

  async onInit() {
    const data = this.getData();
    this.busId = data.busId;
    this.address = data.address;

    const store = this.getStore();
    this.supportsTc = store.supportsTc ?? false;
    this.tcWarmest = store.tcWarmest ?? DEFAULT_TC_WARMEST;
    this.tcCoolest = store.tcCoolest ?? DEFAULT_TC_COOLEST;

    this.log('DT8LightDevice has been initialized:', this.getName(), `(Bus ${this.busId}, Address ${this.address})`);
    this.log(`  Colour temperature support: ${this.supportsTc}, Range: ${this.tcWarmest}K - ${this.tcCoolest}K`);

    // Add dali_level capability if it doesn't exist (for existing devices)
    if (!this.hasCapability('dali_level')) {
      this.log('Adding dali_level capability to existing device');
      await this.addCapability('dali_level').catch(this.error);
    }

    this.registerCapabilityListener('onoff', this.onCapabilityOnOff.bind(this));
    this.registerCapabilityListener('dim', this.onCapabilityDim.bind(this));
    this.registerCapabilityListener('dali_level', this.onCapabilityDaliLevel.bind(this));

    if (this.hasCapability('light_temperature')) {
      this.registerCapabilityListener('light_temperature', this.onCapabilityLightTemperature.bind(this));
    }

    await this.syncStateFromServer();
  }

  async syncStateFromServer() {
    const app = this.homey.app as unknown as { getDaliState: (busId: number) => DaliState | undefined };
    const state = app.getDaliState(this.busId);
    if (state) {
      const gear = state.gears.find((g: DaliGear) => g.address === this.address);
      if (gear) {
        const isOn = gear.level > 0;
        const percent = arcToPercent(gear.level);
        const dimValue = arcToDim(gear.level);

        await this.setCapabilityValue('onoff', isOn).catch(this.error);
        await this.setCapabilityValue('dim', dimValue).catch(this.error);
        await this.setCapabilityValue('dali_level', gear.level).catch(this.error);

        // Sync colour temperature if available
        if (this.hasCapability('light_temperature') && gear.tcCurrent !== undefined) {
          const tempValue = this.kelvinToHomey(gear.tcCurrent);
          await this.setCapabilityValue('light_temperature', tempValue).catch(this.error);
        }

        this.log('Synced state from server:', {
          isOn, level: gear.level, percent, dimValue, tcCurrent: gear.tcCurrent,
        });
      }
    }
  }

  // Convert Kelvin to Homey's 0-1 range (0=warm, 1=cool)
  private kelvinToHomey(kelvin: number): number {
    const range = this.tcCoolest - this.tcWarmest;
    if (range === 0) return 0.5;
    const value = (kelvin - this.tcWarmest) / range;
    return Math.max(0, Math.min(1, value));
  }

  // Convert Homey's 0-1 range to Kelvin
  private homeyToKelvin(value: number): number {
    return Math.round(this.tcWarmest + value * (this.tcCoolest - this.tcWarmest));
  }

  async onCapabilityOnOff(value: boolean): Promise<void> {
    this.log('onCapabilityOnOff:', value);

    const app = this.homey.app as unknown as { getDaliClient: () => DaliApiClient | undefined };
    const client = app.getDaliClient();

    if (!client) {
      this.error('DALI client not initialized. Please configure server URL in app settings.');
      throw new Error('DALI Hub not connected');
    }

    if (value) {
      await client.setLightOn(this.busId, this.address);
      await this.setCapabilityValue('dim', 1.0).catch(this.error);
      await this.setCapabilityValue('dali_level', 254).catch(this.error);
    } else {
      await client.setLightOff(this.busId, this.address);
      await this.setCapabilityValue('dim', 0).catch(this.error);
      await this.setCapabilityValue('dali_level', 0).catch(this.error);
    }
  }

  async onCapabilityDim(value: number): Promise<void> {
    this.log('onCapabilityDim:', value);

    const app = this.homey.app as unknown as { getDaliClient: () => DaliApiClient | undefined };
    const client = app.getDaliClient();

    if (!client) {
      this.error('DALI client not initialized. Please configure server URL in app settings.');
      throw new Error('DALI Hub not connected');
    }

    const percent = Math.round(value * 100);
    const level = percentToArc(percent);

    await client.setLightPercent(this.busId, this.address, percent);

    if (percent > 0) {
      await this.setCapabilityValue('onoff', true).catch(this.error);
    } else {
      await this.setCapabilityValue('onoff', false).catch(this.error);
    }

    await this.setCapabilityValue('dali_level', level).catch(this.error);
  }

  async onCapabilityDaliLevel(value: number): Promise<void> {
    await this.setDaliLevel(value);
  }

  async onCapabilityLightTemperature(value: number): Promise<void> {
    this.log('onCapabilityLightTemperature:', value);

    const app = this.homey.app as unknown as { getDaliClient: () => DaliApiClient | undefined };
    const client = app.getDaliClient();

    if (!client) {
      this.error('DALI client not initialized. Please configure server URL in app settings.');
      throw new Error('DALI Hub not connected');
    }

    const kelvin = this.homeyToKelvin(value);
    this.log(`  -> Setting colour temperature to ${kelvin}K`);

    await client.setColourTemperatureKelvin(this.busId, this.address, kelvin);
  }

  async setColourTemperature(value: number): Promise<void> {
    // Flow action: value is Homey's 0-1 range
    await this.onCapabilityLightTemperature(value);
    await this.setCapabilityValue('light_temperature', value).catch(this.error);
  }

  async setDaliLevel(value: number, fadeTime?: number): Promise<void> {
    this.log('setDaliLevel:', value, fadeTime !== undefined ? `fadeTime: ${fadeTime}` : '');

    const app = this.homey.app as unknown as { getDaliClient: () => DaliApiClient | undefined };
    const client = app.getDaliClient();

    if (!client) {
      this.error('DALI client not initialized. Please configure server URL in app settings.');
      throw new Error('DALI Hub not connected');
    }

    const level = Math.round(value);

    await client.setLightLevel(this.busId, this.address, level, fadeTime);

    const dimValue = arcToDim(level);

    if (level > 0) {
      await this.setCapabilityValue('onoff', true).catch(this.error);
    } else {
      await this.setCapabilityValue('onoff', false).catch(this.error);
    }

    await this.setCapabilityValue('dim', dimValue).catch(this.error);
    await this.setCapabilityValue('dali_level', level).catch(this.error);

    await this.driver.triggerLevelChanged(this, { level }).catch(this.error);
  }

  async updateLevelFromEvent(level: number) {
    const isOn = level > 0;
    const percent = arcToPercent(level);
    const dimValue = arcToDim(level);

    await this.setCapabilityValue('onoff', isOn).catch(this.error);
    await this.setCapabilityValue('dim', dimValue).catch(this.error);
    await this.setCapabilityValue('dali_level', level).catch(this.error);

    this.log('Updated from event:', {
      isOn, level, percent, dimValue,
    });

    await this.driver.triggerLevelChanged(this, { level }).catch(this.error);
  }

  async increaseBrightness(): Promise<void> {
    const app = this.homey.app as unknown as { getDaliClient: () => DaliApiClient | undefined };
    const client = app.getDaliClient();

    if (!client) {
      this.error('DALI client not initialized. Please configure server URL in app settings.');
      throw new Error('DALI Hub not connected');
    }

    await client.setLightUp(this.busId, this.address);
  }

  async decreaseBrightness(): Promise<void> {
    const app = this.homey.app as unknown as { getDaliClient: () => DaliApiClient | undefined };
    const client = app.getDaliClient();

    if (!client) {
      this.error('DALI client not initialized. Please configure server URL in app settings.');
      throw new Error('DALI Hub not connected');
    }

    await client.setLightDown(this.busId, this.address);
  }

  async onDeleted() {
    this.log('DT8LightDevice has been deleted');
  }
}

module.exports = DT8LightDevice;
