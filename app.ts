'use strict';

import Homey from 'homey';
import { DaliApiClient, DaliState, DaliEvent } from './lib/dali-api';
import { DaliMqttClient, MqttConfig } from './lib/mqtt-client';

interface DaliDevice extends Homey.Device {
  getData(): { busId: number; address?: number; groupId?: number; instanceIndex?: number };
  updateLevelFromEvent(level: number, source?: string, command?: string): Promise<void>;
  handleOccupancyEvent?(eventCode: number): Promise<void>;
  handleButtonEvent?(eventCode: number): Promise<void>;
  updateLuxValue?(luxValue: number): Promise<void>;
  updateIlluminance?(illuminance: number): Promise<void>;
  syncStateFromServer?(): Promise<void>;
}

class DaliHubApp extends Homey.App {
  private daliClient!: DaliApiClient;
  private mqttClient: DaliMqttClient | null = null;
  private daliState: Map<number, DaliState> = new Map();
  private readonly BUS_IDS = [0, 1, 2, 3];

  /**
   * onInit is called when the app is initialized.
   */
  async onInit() {
    this.log('DALIHub app has been initialized');

    // Listen for settings changes
    this.homey.settings.on('set', (key: string) => {
      this.onSettingsChanged(key).catch((error: Error) => {
        this.error('Error handling settings change:', error);
      });
    });

    // Get server URL from settings
    const serverUrl = this.homey.settings.get('server_url');

    if (serverUrl) {
      this.log(`Connecting to DALI Hub at ${serverUrl}`);
      await this.initializeConnection(serverUrl);
    } else {
      this.log('No server URL configured. Please configure the app in settings.');
    }

    // Register flow action cards
    this.homey.flow.getActionCard('enable-all-occupancy-sensors').registerRunListener(async () => {
      await this.setAllOccupancySensors(true);
    });

    this.homey.flow.getActionCard('disable-all-occupancy-sensors').registerRunListener(async () => {
      await this.setAllOccupancySensors(false);
    });
  }

  async onUninit() {
    this.log('DALIHub app is shutting down');
    if (this.mqttClient) {
      this.mqttClient.disconnect();
    }
  }

  async onSettingsChanged(key: string) {
    this.log(`Settings have been changed: ${key}`);

    // Check if any connection-related settings changed
    const connectionSettings = ['server_url', 'mqtt_broker_url', 'mqtt_topic_prefix', 'mqtt_username', 'mqtt_password'];

    if (connectionSettings.includes(key)) {
      const serverUrl = this.homey.settings.get('server_url');

      if (serverUrl) {
        this.log(`Reconnecting with updated settings...`);

        // Disconnect existing MQTT connection
        if (this.mqttClient) {
          this.mqttClient.disconnect();
          this.mqttClient = null;
        }

        // Clear existing state
        this.daliState.clear();

        // Initialize new connection
        await this.initializeConnection(serverUrl);

        // Push reloaded state to existing device tiles
        this.syncAllDevices();
      } else {
        this.log('Server URL removed, disconnecting...');
        if (this.mqttClient) {
          this.mqttClient.disconnect();
          this.mqttClient = null;
        }
      }
    }
  }

  private async initializeConnection(serverUrl: string): Promise<void> {
    try {
      this.daliClient = new DaliApiClient(serverUrl, this.log.bind(this));

      await this.loadInitialState();

      // Setup MQTT connection for real-time events
      // DALIHub server runs on Raspberry Pi with Mosquitto MQTT broker
      // Default: mqtt://<server-ip>:1883, credentials: dalihub/dalihub
      const mqttBrokerUrl = this.homey.settings.get('mqtt_broker_url');

      if (mqttBrokerUrl) {
        const mqttConfig: MqttConfig = {
          brokerUrl: mqttBrokerUrl,
          topicPrefix: this.homey.settings.get('mqtt_topic_prefix') || 'dalihub',
          username: this.homey.settings.get('mqtt_username') || 'dalihub',
          password: this.homey.settings.get('mqtt_password') || 'dalihub',
        };

        this.mqttClient = new DaliMqttClient(mqttConfig, this.homey, this.log.bind(this));
        this.setupMqttEventHandlers();
        this.mqttClient.connect();
      } else {
        this.log('No MQTT broker URL configured. Real-time events will not be available.');
        this.log('Configure MQTT in app settings: mqtt://<server-ip>:1883');
      }
    } catch (error) {
      this.error('Failed to initialize connection:', error);
    }
  }

  private async loadInitialState(): Promise<void> {
    this.log('Loading initial state for all buses...');

    for (const busId of this.BUS_IDS) {
      try {
        const state = await this.daliClient.getState(busId);
        this.daliState.set(busId, state);
        this.log(`Bus ${busId} state loaded: ${state.gears.length} gears, ${state.groups.length} groups, ${state.controlDevices.length} control devices`);
      } catch (error) {
        this.error(`Failed to load state for bus ${busId}:`, error);
      }
    }
  }

  private setupMqttEventHandlers(): void {
    if (!this.mqttClient) return;

    this.mqttClient.on('gear.changed', (event) => {
      this.handleGearChanged(event);
    });

    this.mqttClient.on('group.changed', (event) => {
      this.handleGroupChanged(event);
    });

    this.mqttClient.on('push-button.event', (event) => {
      this.handlePushButtonEvent(event);
    });

    this.mqttClient.on('occupancy.event', (event) => {
      this.handleOccupancyEvent(event);
    });

    this.mqttClient.on('control-device.lux', (event) => {
      this.handleControlDeviceLux(event);
    });

    this.mqttClient.on('control-device.illuminance', (event) => {
      this.handleControlDeviceIlluminance(event);
    });

    this.mqttClient.onStatus((online) => {
      this.log(`Server status changed: ${online ? 'online' : 'offline'}`);
      if (online) {
        // Reload state when server comes back online, then push it to the
        // device tiles — MQTT only delivers deltas, so anything that changed
        // while the server was offline must be caught up here
        this.loadInitialState()
          .then(() => this.syncAllDevices())
          .catch((error) => {
            this.error('Failed to reload state after server came online:', error);
          });
      }
    });
  }

  /**
   * Push the freshly loaded state to every device's capabilities.
   * Without this, a reload only updates the app's cache and the tiles
   * keep showing values from before the disconnect.
   */
  private syncAllDevices(): void {
    const drivers = this.homey.drivers.getDrivers();
    Object.values(drivers).forEach((driver) => {
      const devices = driver.getDevices() as DaliDevice[];
      devices.forEach((device) => {
        device.syncStateFromServer?.().catch((err: Error) => {
          this.error(`Failed to sync ${device.getName()}:`, err);
        });
      });
    });
  }

  private handleGearChanged(event: DaliEvent): void {
    if (event.type !== 'gear.changed') return;

    const { level, address } = event;

    this.log(`Gear Changed - Bus ${event.busId}, Address ${address}, Level ${level}`);

    const state = this.daliState.get(event.busId);
    if (state) {
      const gear = state.gears.find((g) => g.address === address);
      if (gear) {
        gear.level = level;
        gear.lastUpdated = new Date().toISOString();
      }
    }

    const drivers = this.homey.drivers.getDrivers();
    ['dimmable-light', 'bistable-light', 'dt8-light'].forEach((driverName) => {
      const driver = drivers[driverName];
      if (driver) {
        const devices = driver.getDevices() as DaliDevice[];
        devices.forEach((device) => {
          const deviceData = device.getData();
          if (deviceData.busId === event.busId && deviceData.address === address) {
            device.updateLevelFromEvent(level, event.source, event.command).catch((err: Error) => {
              this.error('Failed to update device level:', err);
            });
          }
        });
      }
    });
  }

  private handleGroupChanged(event: DaliEvent): void {
    if (event.type !== 'group.changed') return;

    const { level, groupId } = event;

    this.log(`Group Changed - Bus ${event.busId}, Group ${groupId}, Level ${level}`);

    const state = this.daliState.get(event.busId);
    if (state) {
      const group = state.groups.find((g) => g.groupId === groupId);
      if (group) {
        group.level = level;
      }
    }

    const driver = this.homey.drivers.getDriver('light-group');
    if (driver) {
      const devices = driver.getDevices() as DaliDevice[];
      devices.forEach((device) => {
        const deviceData = device.getData();
        if (deviceData.busId === event.busId && deviceData.groupId === groupId) {
          this.log(`  -> Updating device: ${device.getName()}`);
          device.updateLevelFromEvent(level, event.source, event.command).catch((err: Error) => {
            this.error('Failed to update group level:', err);
          });
        }
      });
    }
  }

  private handlePushButtonEvent(event: DaliEvent): void {
    if (event.type !== 'push-button.event') return;
    const { busId, address, instanceIndex, eventCode } = event;

    const driver = this.homey.drivers.getDrivers()['push-button'];
    if (!driver) return;

    const devices = driver.getDevices() as DaliDevice[];
    devices.forEach((device) => {
      const deviceData = device.getData();
      if (deviceData.busId === busId
          && deviceData.address === address
          && deviceData.instanceIndex === instanceIndex) {
        device.handleButtonEvent?.(eventCode).catch((err: Error) => {
          this.error('Failed to handle button event:', err);
        });
      }
    });
  }

  private handleOccupancyEvent(event: DaliEvent): void {
    if (event.type !== 'occupancy.event') return;
    const { busId, address, instanceIndex, eventCode } = event;

    const driver = this.homey.drivers.getDrivers()['occupancy-sensor'];
    if (!driver) return;

    const devices = driver.getDevices() as DaliDevice[];
    devices.forEach((device) => {
      const deviceData = device.getData();
      if (deviceData.busId === busId
          && deviceData.address === address
          && deviceData.instanceIndex === instanceIndex) {
        device.handleOccupancyEvent?.(eventCode).catch((err: Error) => {
          this.error('Failed to handle occupancy event:', err);
        });
      }
    });
  }

  private handleControlDeviceLux(event: DaliEvent): void {
    if (event.type !== 'control-device.lux') return;

    const { address, instanceIndex, luxValue } = event;

    const state = this.daliState.get(event.busId);
    if (state) {
      const controlDevice = state.controlDevices.find((cd) => cd.address === address);
      if (controlDevice) {
        const instance = controlDevice.instances.find((i) => i.index === instanceIndex);
        if (instance) {
          instance.luxValue = luxValue;
          instance.luxUpdated = new Date().toISOString();
        }
      }
    }

    const driver = this.homey.drivers.getDriver('lux-sensor');
    if (driver) {
      const devices = driver.getDevices() as DaliDevice[];
      devices.forEach((device) => {
        const deviceData = device.getData();
        if (deviceData.busId === event.busId
            && deviceData.address === address
            && deviceData.instanceIndex === instanceIndex) {
          device.updateLuxValue?.(luxValue).catch((err: Error) => {
            this.error('Failed to update lux value:', err);
          });
        }
      });
    }
  }

  private handleControlDeviceIlluminance(event: DaliEvent): void {
    if (event.type !== 'control-device.illuminance') return;

    const { address, instanceIndex, illuminance } = event;

    const state = this.daliState.get(event.busId);
    if (state) {
      const controlDevice = state.controlDevices.find((cd) => cd.address === address);
      if (controlDevice) {
        const instance = controlDevice.instances.find((i) => i.index === instanceIndex);
        if (instance) {
          instance.illuminance = illuminance;
          instance.illuminanceUpdated = new Date().toISOString();
        }
      }
    }

    const driver = this.homey.drivers.getDriver('lux-sensor');
    if (driver) {
      const devices = driver.getDevices() as DaliDevice[];
      devices.forEach((device) => {
        const deviceData = device.getData();
        if (deviceData.busId === event.busId
            && deviceData.address === address
            && deviceData.instanceIndex === instanceIndex) {
          device.updateIlluminance?.(illuminance).catch((err: Error) => {
            this.error('Failed to update illuminance:', err);
          });
        }
      });
    }
  }

  private async setAllOccupancySensors(enabled: boolean): Promise<void> {
    const driver = this.homey.drivers.getDrivers()['occupancy-sensor'];
    if (!driver) {
      this.log('No occupancy-sensor driver found');
      return;
    }

    const devices = driver.getDevices();
    this.log(`${enabled ? 'Enabling' : 'Disabling'} all occupancy sensors (${devices.length} devices)`);

    for (const device of devices) {
      try {
        await device.setCapabilityValue('onoff', enabled);
      } catch (err) {
        this.error(`Failed to ${enabled ? 'enable' : 'disable'} ${device.getName()}:`, err);
      }
    }
  }

  getDaliClient(): DaliApiClient | undefined {
    return this.daliClient;
  }

  getDaliState(busId: number): DaliState | undefined {
    return this.daliState.get(busId);
  }

  async reloadState(busId?: number): Promise<void> {
    if (busId !== undefined) {
      // Reload specific bus
      try {
        const state = await this.daliClient.getState(busId);
        this.daliState.set(busId, state);
        this.log(`Bus ${busId} state reloaded: ${state.gears.length} gears, ${state.groups.length} groups, ${state.controlDevices.length} control devices`);
      } catch (error) {
        this.error(`Failed to reload state for bus ${busId}:`, error);
      }
    } else {
      // Reload all buses
      await this.loadInitialState();
    }
  }
}

module.exports = DaliHubApp;
