import Homey from 'homey';

class PushButtonDevice extends Homey.Device {
  private busId!: number;
  private address!: number;
  private instanceIndex!: number;
  private shortPressFlow!: Homey.FlowCardTriggerDevice;
  private doublePressFlow!: Homey.FlowCardTriggerDevice;
  private longPressStartFlow!: Homey.FlowCardTriggerDevice;
  private longPressRepeatFlow!: Homey.FlowCardTriggerDevice;
  private longPressStopFlow!: Homey.FlowCardTriggerDevice;

  async onInit() {
    const data = this.getData();
    this.busId = data.busId;
    this.address = data.address;
    this.instanceIndex = data.instanceIndex;

    this.log('PushButtonDevice has been initialized:', this.getName(), `(Bus ${this.busId}, Address ${this.address}, Instance ${this.instanceIndex})`);

    this.shortPressFlow = this.homey.flow.getDeviceTriggerCard('push-button-short-press');
    this.doublePressFlow = this.homey.flow.getDeviceTriggerCard('push-button-double-press');
    this.longPressStartFlow = this.homey.flow.getDeviceTriggerCard('push-button-long-press-start');
    this.longPressRepeatFlow = this.homey.flow.getDeviceTriggerCard('push-button-long-press-repeat');
    this.longPressStopFlow = this.homey.flow.getDeviceTriggerCard('push-button-long-press-stop');
  }

  async handleButtonEvent(eventCode?: number) {
    if (eventCode === undefined) return;
    if (!this.shortPressFlow) return;

    // this.log('Button event:', eventCode);

    switch (eventCode) {
      case 2:
        await this.shortPressFlow.trigger(this, {}, {}).catch(this.error);
        break;
      // IEC 62386-301 Table 2: double press = 5 (3 is reserved)
      case 5:
        await this.doublePressFlow.trigger(this, {}, {}).catch(this.error);
        break;
      case 9:
        await this.longPressStartFlow.trigger(this, {}, {}).catch(this.error);
        break;
      case 11:
        await this.longPressRepeatFlow.trigger(this, {}, {}).catch(this.error);
        break;
      case 12:
        await this.longPressStopFlow.trigger(this, {}, {}).catch(this.error);
        break;
    }
  }

  async onDeleted() {
    this.log('PushButtonDevice has been deleted');
  }
}

module.exports = PushButtonDevice;
