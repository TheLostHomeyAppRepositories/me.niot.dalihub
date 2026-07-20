import Homey from 'homey';
import {
  DaliGear, DaliState, DaliApiClient, arcToPercent, percentToArc, arcToDim,
} from '../../lib/dali-api';

interface DimmableLightDriver extends Homey.Driver {
  triggerLevelChanged(device: Homey.Device, tokens: { level: number }): Promise<void>;
  triggerExternalOn(device: Homey.Device, tokens: { command: string }): Promise<void>;
  triggerExternalOff(device: Homey.Device, tokens: { command: string }): Promise<void>;
}

class DimmableLightDevice extends Homey.Device {
  declare driver: DimmableLightDriver;
  private busId!: number;
  private address!: number;

  async onInit() {
    const data = this.getData();
    this.busId = data.busId;
    this.address = data.address;

    this.log('DimmableLightDevice has been initialized:', this.getName(), `(Bus ${this.busId}, Address ${this.address})`);

    // Add dali_level capability if it doesn't exist (for existing devices)
    if (!this.hasCapability('dali_level')) {
      this.log('Adding dali_level capability to existing device');
      await this.addCapability('dali_level').catch(this.error);
    }

    this.registerCapabilityListener('onoff', this.onCapabilityOnOff.bind(this));
    this.registerCapabilityListener('dim', this.onCapabilityDim.bind(this));
    this.registerCapabilityListener('dali_level', this.onCapabilityDaliLevel.bind(this));

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

        this.log('Synced state from server:', {
          isOn, level: gear.level, percent, dimValue,
        });
      }
    }
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
      // Update dim to 100% when turning on
      await this.setCapabilityValue('dim', 1.0).catch(this.error);
      await this.setCapabilityValue('dali_level', 254).catch(this.error);
    } else {
      await client.setLightOff(this.busId, this.address);
      // Update dim to 0% when turning off
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

    // Update dali_level to reflect the change
    await this.setCapabilityValue('dali_level', level).catch(this.error);
  }

  async onCapabilityDaliLevel(value: number): Promise<void> {
    await this.setDaliLevel(value);
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

    // Update dim and onoff to reflect the change
    const dimValue = arcToDim(level);

    if (level > 0) {
      await this.setCapabilityValue('onoff', true).catch(this.error);
    } else {
      await this.setCapabilityValue('onoff', false).catch(this.error);
    }

    await this.setCapabilityValue('dim', dimValue).catch(this.error);
    await this.setCapabilityValue('dali_level', level).catch(this.error);

    // Trigger flow card
    await this.driver.triggerLevelChanged(this, { level }).catch(this.error);
  }

  async setDim(brightness: number): Promise<void> {
    this.log('setDim:', brightness);

    const app = this.homey.app as unknown as { getDaliClient: () => DaliApiClient | undefined };
    const client = app.getDaliClient();

    if (!client) {
      this.error('DALI client not initialized. Please configure server URL in app settings.');
      throw new Error('DALI Hub not connected');
    }

    const percent = Math.round(brightness);
    const level = percentToArc(percent);

    await client.setLightPercent(this.busId, this.address, percent);

    if (percent > 0) {
      await this.setCapabilityValue('onoff', true).catch(this.error);
    } else {
      await this.setCapabilityValue('onoff', false).catch(this.error);
    }

    await this.setCapabilityValue('dali_level', level).catch(this.error);
    await this.setCapabilityValue('dim', brightness / 100).catch(this.error);

    await this.driver.triggerLevelChanged(this, { level }).catch(this.error);
  }

  async setDimWithFade(brightness: number, fadeTime: number): Promise<void> {
    this.log('setDimWithFade:', brightness, 'fadeTime:', fadeTime);

    const app = this.homey.app as unknown as { getDaliClient: () => DaliApiClient | undefined };
    const client = app.getDaliClient();

    if (!client) {
      this.error('DALI client not initialized. Please configure server URL in app settings.');
      throw new Error('DALI Hub not connected');
    }

    const percent = Math.round(brightness);
    const level = percentToArc(percent);

    await client.setLightPercent(this.busId, this.address, percent, fadeTime);

    if (percent > 0) {
      await this.setCapabilityValue('onoff', true).catch(this.error);
    } else {
      await this.setCapabilityValue('onoff', false).catch(this.error);
    }

    // Update dali_level to reflect the change
    await this.setCapabilityValue('dali_level', level).catch(this.error);
    await this.setCapabilityValue('dim', brightness / 100).catch(this.error);

    // Trigger flow card
    await this.driver.triggerLevelChanged(this, { level }).catch(this.error);
  }

  async updateLevelFromEvent(level: number, source?: string, command?: string) {
    const isOn = level > 0;
    const percent = arcToPercent(level);
    const dimValue = arcToDim(level);

    await this.setCapabilityValue('onoff', isOn).catch(this.error);
    await this.setCapabilityValue('dim', dimValue).catch(this.error);
    await this.setCapabilityValue('dali_level', level).catch(this.error);

    this.log('Updated from event:', {
      isOn, level, percent, dimValue, source, command,
    });

    // Trigger flow card
    await this.driver.triggerLevelChanged(this, { level }).catch(this.error);

    // Trigger external ON/OFF flow cards
    if (source === 'external' && command) {
      if (isOn) {
        await this.driver.triggerExternalOn(this, { command }).catch(this.error);
      } else {
        await this.driver.triggerExternalOff(this, { command }).catch(this.error);
      }
    }
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
    this.log('DimmableLightDevice has been deleted');
  }
}

module.exports = DimmableLightDevice;
