const { Service, Characteristic } = require('../types');
const WyzeAccessory = require('./WyzeAccessory');
const ColorConverter = require('color-convert');

const WYZE_API_POWER_PROPERTY = 'P3';
const WYZE_API_BRIGHTNESS_PROPERTY = 'P1501';
const WYZE_API_COLOR_TEMP_PROPERTY = 'P1502';
const WYZE_API_COLOR_PROPERTY = 'P1507';

const WYZE_COLOR_TEMP_MIN = 1800;
const WYZE_COLOR_TEMP_MAX = 6500;
const HOMEKIT_COLOR_TEMP_MIN = 153;
const HOMEKIT_COLOR_TEMP_MAX = 555;

module.exports = class WyzeMeshLight extends WyzeAccessory {
  constructor(plugin, homeKitAccessory) {
    super(plugin, homeKitAccessory);

    this.getCharacteristic(Characteristic.On).on('set', this.setOn.bind(this));
    this.getCharacteristic(Characteristic.Brightness).on('set', this.setBrightness.bind(this));
    this.getCharacteristic(Characteristic.ColorTemperature).on('set', this.setColorTemperature.bind(this));
    this.getCharacteristic(Characteristic.Hue).on('set', this.setHue.bind(this));
    this.getCharacteristic(Characteristic.Saturation).on('set', this.setSaturation.bind(this));

    // Local caching of HSL color space handling separate Hue & Saturation on HomeKit
    // Caching idea for handling HSL colors from:
    //    https://github.com/QuickSander/homebridge-http-rgb-push/blob/master/index.js
    this.cache = {};
    this.cacheUpdated = false;
  }

  async updateCharacteristics(device) {
    this.getCharacteristic(Characteristic.On).updateValue(device.device_params.switch_state);

    let propertyList = await this.getPropertyList();
    for (let property of propertyList.data.property_list) {
      switch (property.pid) {
        case WYZE_API_BRIGHTNESS_PROPERTY:
          this.updateBrightness(property.value);
          break;

        case WYZE_API_COLOR_TEMP_PROPERTY:
          this.updateColorTemp(property.value);
          break;

        case WYZE_API_COLOR_PROPERTY:
          this.updateColor(property.value);
          break;
      }
    }
  }

  updateBrightness(value) {
    this.getCharacteristic(Characteristic.Brightness).updateValue(value);
  }

  updateColorTemp(value) {
    let floatValue = this._rangeToFloat(value, WYZE_COLOR_TEMP_MIN, WYZE_COLOR_TEMP_MAX);
    let homeKitValue = this._floatToRange(floatValue, HOMEKIT_COLOR_TEMP_MIN, HOMEKIT_COLOR_TEMP_MAX);
    this.getCharacteristic(Characteristic.ColorTemperature).updateValue(homeKitValue);
  }

  updateColor(value) {
    // Convert a Hex color from Wyze into the HSL values recognized by HomeKit.
    let hslValue = ColorConverter.rgb.hsv(ColorConverter.hex.rgb(value));
    this.plugin.log.debug(`Updating color record for ${this.homeKitAccessory.context.mac} to ${value}: ${JSON.stringify(hslValue)}`)

    // Update Hue
    this.updateHue(hslValue[0]);
    this.cache.hue = hslValue[0];

    // Update Saturation
    this.updateSaturation(hslValue[1]);
    this.cache.saturation = hslValue[1];

    this.cache.brightness = hslValue[2];
  }

  updateHue(value) {
    this.getCharacteristic(Characteristic.Hue).updateValue(value);
  }

  updateSaturation(value) {
    this.getCharacteristic(Characteristic.Saturation).updateValue(value);
  }

  getService() {
    let service = this.homeKitAccessory.getService(Service.Lightbulb);

    if (!service) {
      service = this.homeKitAccessory.addService(Service.Lightbulb);
    }

    return service;
  }

  getCharacteristic(characteristic) {
    return this.getService().getCharacteristic(characteristic);
  }

  async setOn(value, callback) {
    this.plugin.log.info(`Setting power for ${this.homeKitAccessory.context.mac} to ${value}`);

    try {
      await this.setBufferedProperty(WYZE_API_POWER_PROPERTY, (value) ? '1' : '0');
      callback();
    } catch (e) {
      callback(e);
    }
  }

  async setBrightness(value, callback) {
    this.plugin.log.info(`Setting brightness for ${this.homeKitAccessory.context.mac} to ${value}`);

    try {
      await this.setBufferedProperty(WYZE_API_BRIGHTNESS_PROPERTY, value);
      this.cache.brightness = value;
      callback();
    } catch (e) {
      callback(e);
    }
  }

  async setColorTemperature(value, callback) {
    let floatValue = this._rangeToFloat(value, HOMEKIT_COLOR_TEMP_MIN, HOMEKIT_COLOR_TEMP_MAX);
    let wyzeValue = this._floatToRange(floatValue, WYZE_COLOR_TEMP_MIN, WYZE_COLOR_TEMP_MAX);

    this.plugin.log.info(`Setting color temperature for ${this.homeKitAccessory.context.mac} to ${value} (${wyzeValue})`);

    try {
      await this.setBufferedProperty(WYZE_API_COLOR_TEMP_PROPERTY, wyzeValue);
      callback();
    } catch (e) {
      callback(e);
    }
  }

  async applyColorCache(callback) {
    try {
      if (this.cacheUpdated) {
        let hexValue = ColorConverter.rgb.hex(ColorConverter.hsv.rgb(this.cache.hue, this.cache.saturation, 100));
        this.plugin.log.info(`Applying RGB for ${this.homeKitAccessory.context.nickname} ${hexValue}`);

        await this.setBufferedProperty(WYZE_API_COLOR_PROPERTY, hexValue);
        this.cacheUpdated = false;
      } else {
        this.cacheUpdated = true;
      }
      callback();
    } catch (e) {
      callback(e);
    }
  }

  async setHue(value, callback) {
    this.plugin.log.info(`Setting hue (color) for ${this.homeKitAccessory.context.mac} to ${value}`);
    this.plugin.log.debug(`(H)SL Values: ${value}, ${this.cache.saturation}, ${this.cache.brightness}`);
    this.cache.hue = value;
    this.applyColorCache(callback);
  }

  async setSaturation(value, callback) {
    this.plugin.log.info(`Setting saturation (color) for ${this.homeKitAccessory.context.mac} to ${value}`);
    this.plugin.log.debug(`H(S)L Values: ${this.cache.hue}, ${value}, ${this.cache.brightness}`);
    this.cache.saturation = value;
    this.applyColorCache(callback);
  }

  _rangeToFloat(value, min, max) {
    return (value - min) / (max - min);
  }

  _floatToRange(value, min, max) {
    return Math.round((value * (max - min)) + min);
  }
};
