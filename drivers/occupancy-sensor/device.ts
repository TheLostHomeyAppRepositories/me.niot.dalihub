import Homey from 'homey';

class OccupancySensorDevice extends Homey.Device {
  private busId!: number;
  private address!: number;
  private instanceIndex!: number;
  private occupancyStateChangedFlow!: Homey.FlowCardTriggerDevice;

  async onInit() {
    const data = this.getData();
    this.busId = data.busId;
    this.address = data.address;
    this.instanceIndex = data.instanceIndex;

    this.log('OccupancySensorDevice has been initialized:', this.getName(), `(Bus ${this.busId}, Address ${this.address}, Instance ${this.instanceIndex})`);

    // Add capabilities if they don't exist (for existing paired devices)
    if (!this.hasCapability('onoff')) {
      await this.addCapability('onoff').catch(this.error);
      this.log('Added onoff capability');
    }
    if (!this.hasCapability('alarm_motion')) {
      await this.addCapability('alarm_motion').catch(this.error);
      this.log('Added alarm_motion capability');
    }
    if (!this.hasCapability('occupancy_state')) {
      await this.addCapability('occupancy_state').catch(this.error);
      this.log('Added occupancy_state capability');
    }

    // Default to enabled
    if (this.getCapabilityValue('onoff') === null) {
      await this.setCapabilityValue('onoff', true).catch(this.error);
    }

    this.registerCapabilityListener('onoff', async (value: boolean) => {
      this.log(`Sensor ${value ? 'enabled' : 'disabled'}`);
      if (!value) {
        // Zone semantics: a disabled sensor must not show motion / drive zone activity.
        // occupancy_state is NOT reset — it keeps mirroring the DALI sensor's state
        // machine so we are in sync the moment the sensor is re-enabled.
        await this.setCapabilityValue('alarm_motion', false).catch(this.error);
      } else {
        // Sync kick: commit onoff first so flow condition cards see the new value,
        // then re-fire the trigger if the mirrored state says someone is present.
        // Without this, a person already inside when the sensor is enabled stays
        // invisible until the DALI sensor fully cycles vacant -> occupied again.
        await this.setCapabilityValue('onoff', true).catch(this.error);
        const occupancy = this.getOccupancyState();
        if (occupancy === 'occupied' || occupancy === 'still_occupied') {
          this.log(`Enable sync kick: mirrored state is '${occupancy}', re-firing trigger`);
          const tokens = {
            occupancy,
            movement: this.getCapabilityValue('alarm_motion') === true,
            sensor_type: 'presence',
          };
          await this.occupancyStateChangedFlow.trigger(this, tokens, tokens)
            .catch((err) => this.error('Failed to trigger flow card on enable:', err));
        }
      }
    });

    this.occupancyStateChangedFlow = this.homey.flow.getDeviceTriggerCard('occupancy-state-changed');
  }

  getOccupancyState(): string {
    return this.getCapabilityValue('occupancy_state') || 'vacant';
  }

  async handleOccupancyEvent(eventCode?: number) {
    if (eventCode === undefined) return;
    if (!this.occupancyStateChangedFlow) return;

    // IEC 62386-303 bitfield decoding
    // bit 0: movement (0=no movement, 1=movement)
    // bit 1-2: occupancy state (00=vacant, 01=occupied, 10=still vacant, 11=still occupied)
    // bit 3: sensor type (0=presence sensor, 1=movement sensor)
    const hasMovement = !!(eventCode & 0x01);
    const occupancyBits = (eventCode >> 1) & 0x03;
    const isMovementSensor = !!(eventCode & 0x08);

    const occupancyNames = ['vacant', 'occupied', 'still_vacant', 'still_occupied'] as const;
    const occupancy = occupancyNames[occupancyBits];
    const sensorType = isMovementSensor ? 'movement' : 'presence';

    this.log(`Occupancy event 0x${eventCode.toString(16)}: ${occupancy}, ${hasMovement ? 'movement' : 'no movement'}, ${sensorType} sensor`);

    // occupancy_state ALWAYS mirrors the DALI sensor's own state machine, even
    // while disabled. The hardware keeps sensing regardless of the enable flag;
    // letting our mirror go stale caused two dual bugs (stuck-occupied blocking
    // zone triggers, and reset-to-vacant making the first pass after re-enable
    // invisible until a full vacant->occupied cycle).
    await this.setCapabilityValue('occupancy_state', occupancy).catch(this.error);

    // Automation contract of "disabled": no motion/zone activity, no flow triggers.
    const isEnabled = this.getCapabilityValue('onoff') !== false;
    if (!isEnabled) {
      this.log('Sensor disabled — state mirrored, no motion/trigger');
      return;
    }

    await this.setCapabilityValue('alarm_motion', hasMovement).catch(this.error);

    // Trigger flow with all decoded fields
    await this.occupancyStateChangedFlow.trigger(
      this,
      {
        occupancy,
        movement: hasMovement,
        sensor_type: sensorType,
      },
      {
        occupancy,
        movement: hasMovement,
        sensor_type: sensorType,
      },
    ).catch((err) => {
      this.error('Failed to trigger flow card:', err);
    });
  }

  async onDeleted() {
    this.log('OccupancySensorDevice has been deleted');
  }
}

module.exports = OccupancySensorDevice;
