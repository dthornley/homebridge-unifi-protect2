/* Copyright(C) 2019-2020, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * protect-camera.ts: Camera device class for UniFi Protect.
 */
import {
  CharacteristicEventTypes,
  CharacteristicGetCallback,
  CharacteristicSetCallback,
  CharacteristicValue
} from "homebridge";
import { ProtectAccessory } from "./protect-accessory";
import { ProtectApi } from "./protect-api";
import { ProtectNvr } from "./protect-nvr";
import { ProtectStreamingDelegate } from "./protect-stream";
import { ProtectCameraConfig, ProtectNvrBootstrap } from "./protect-types";

export class ProtectCamera extends ProtectAccessory {
  cameraUrl!: string;
  isVideoConfigured!: boolean;
  snapshotUrl!: string;
  twoWayAudio!: boolean;

  // Configure a camera accessory for HomeKit.
  protected async configureDevice(): Promise<boolean> {

    this.isVideoConfigured = false;

    // Save the camera object before we wipeout the context.
    const camera = this.accessory.context.camera;

    // Default motion detection support to on.
    let detectMotion = true;

    // Save the motion sensor switch state before we wipeout the context.
    if(this.accessory.context.detectMotion !== undefined) {
      detectMotion = this.accessory.context.detectMotion;
    }

    // Clean out the context object in case it's been polluted somehow.
    this.accessory.context = {};
    this.accessory.context.camera = camera;
    this.accessory.context.nvr = this.nvr.nvrApi.bootstrap.nvr.mac;
    this.accessory.context.detectMotion = detectMotion;

    // Clear out any switches on this camera so we can start fresh.
    let switchService;

    while((switchService = this.accessory.getService(this.hap.Service.Switch))) {
      this.accessory.removeService(switchService);
    }

    // Configure accessory information.
    await this.configureInfo();

    // Configure the motion sensor.
    await this.configureMotionSensor();
    await this.configureMotionSwitch();

    // Configure two-way audio support and our video stream...and we're done.
    await this.configureTwoWayAudio();

    return await this.configureVideoStream();
  }

  // Configure the camera device information for HomeKit.
  private async configureInfo(): Promise<boolean> {
    const accessory = this.accessory;
    const camera: ProtectCameraConfig = accessory.context.camera;
    const hap = this.hap;

    // Update the manufacturer information for this camera.
    accessory
      .getService(hap.Service.AccessoryInformation)!
      .getCharacteristic(hap.Characteristic.Manufacturer).updateValue("Ubiquiti Networks");

    // Update the model information for this camera.
    accessory
      .getService(hap.Service.AccessoryInformation)!
      .getCharacteristic(hap.Characteristic.Model).updateValue(camera.type);

    // Update the serial number for this camera.
    accessory
      .getService(hap.Service.AccessoryInformation)!
      .getCharacteristic(hap.Characteristic.SerialNumber).updateValue(camera.mac);

    // Update the hardware revision for this camera.
    accessory
      .getService(hap.Service.AccessoryInformation)!
      .getCharacteristic(hap.Characteristic.HardwareRevision).updateValue(camera.hardwareRevision);

    // Update the firmware revision for this camera.
    accessory
      .getService(hap.Service.AccessoryInformation)!
      .getCharacteristic(hap.Characteristic.FirmwareRevision).updateValue(camera.firmwareVersion);

    return true;
  }

  // Configure the camera motion sensor for HomeKit.
  private async configureMotionSensor(): Promise<boolean> {
    const accessory = this.accessory;
    const hap = this.hap;

    // Clear out any previous motion sensor service.
    let motionService = accessory.getService(hap.Service.MotionSensor);

    if(motionService) {
      accessory.removeService(motionService);
    }

    // Have we disabled motion sensors?
    if(!this.nvr?.optionEnabled(accessory.context.camera, "MotionSensor")) {
      this.log("%s %s: Disabling motion sensor.",
        this.nvr.nvrApi.getNvrName(), this.nvr.nvrApi.getDeviceName(accessory.context.camera));
      return false;
    }

    // Add the motion sensor to the camera.
    motionService = new hap.Service.MotionSensor(accessory.displayName);
    accessory.addService(motionService);

    return true;
  }

  // Configure a switch to easily activate or deactivate motion sensor detection for HomeKit.
  private async configureMotionSwitch(): Promise<boolean> {

    // Clear out any previous switch service.
    let switchService = this.accessory.getService(this.hap.Service.Switch);

    if(switchService) {
      this.accessory.removeService(switchService);
    }

    // Have we disabled motion sensors or the motion switch?
    if(!this.nvr?.optionEnabled(this.accessory.context.camera, "MotionSensor") ||
      !this.nvr?.optionEnabled(this.accessory.context.camera, "MotionSwitch")) {
      this.log("%s %s: Disabling motion sensor switch.",
        this.nvr.nvrApi.getNvrName(), this.nvr.nvrApi.getDeviceName(this.accessory.context.camera));
      // If we disable the switch, make sure we fully reset it's state.
      delete this.accessory.context.detectMotion;
      return false;
    }

    // Add the switch to the camera.
    switchService = new this.hap.Service.Switch(this.accessory.displayName, "MotionSensorSwitch");

    // Activate or deactivate motion detection.
    this.accessory.addService(switchService)
      .getCharacteristic(this.hap.Characteristic.On)!
      .on(CharacteristicEventTypes.GET, (callback: CharacteristicGetCallback) => {
        callback(null, this.accessory.context.detectMotion);
      })
      .on(CharacteristicEventTypes.SET, (value: CharacteristicValue, callback: CharacteristicSetCallback) => {
        if(this.accessory.context.detectMotion !== value) {
          this.log("%s: Motion detection %s.", this.accessory.displayName, value === true ? "enabled" : "disabled");
        }

        this.accessory.context.detectMotion = value === true;
        callback(null);
      })
      .updateValue(this.accessory.context.detectMotion);

    return true;
  }

  // Configure two-way audio support for HomeKit.
  private async configureTwoWayAudio(): Promise<boolean> {

    // Identify twoway-capable devices.
    switch(this.accessory.context.camera?.type) {
      case "UVC G3 Micro":
      case "UVC G4 Doorbell":
        // Enabled by default unless disabled by the user.
        this.twoWayAudio = this.nvr?.optionEnabled(this.accessory.context.camera, "TwoWayAudio");
        break;

      default:
        this.twoWayAudio = false;
        break;
    }

    return true;
  }

  // Configure a camera accessory for HomeKit.
  async configureVideoStream(): Promise<boolean> {
    const bootstrap: ProtectNvrBootstrap = this.nvr.nvrApi.bootstrap;
    const nvr: ProtectNvr = this.nvr;
    const nvrApi: ProtectApi = this.nvr.nvrApi;

    // No channels exist on this camera.
    if(!this.accessory.context.camera?.channels) {
      return false;
    }

    const camera: ProtectCameraConfig = await nvrApi.enableRtsp(this.accessory.context.camera) ?? this.accessory.context.camera;
    let forceQuality = "";
    let newCameraQuality = "";
    let newCameraUrl = "";

    if(nvr.optionEnabled(camera, "StreamOnly.Low", false)) {
      forceQuality = "Low";
    } else if(nvr.optionEnabled(camera, "StreamOnly.Medium", false)) {
      forceQuality = "Medium";
    } else if(nvr.optionEnabled(camera, "StreamOnly.High", false)) {
      forceQuality = "High";
    }

    // Filter the stream the user has explicitly set. If we can't find the stream quality the
    // user requests, we fail.
    if(forceQuality) {
      const foundChannel = camera.channels.find(channel => {
        // No RTSP channel here.
        if(!channel.isRtspEnabled) {
          return false;
        }

        return channel.name === forceQuality;
      });

      if(foundChannel) {
        newCameraQuality = foundChannel.name;
        newCameraUrl = foundChannel.rtspAlias;
      }
    } else {
      // Our defaults may seem counterintuitive in some cases but here's the rationale:
      // The G4-series of cameras, particularly the G4 Pro and the G4 Bullet push out
      // 3840x2160 and 2688x1520, respectively, if you use the "High" stream setting --
      // that's a lot of data! HomeKit can only handle up to 1920x1080 (1080p) streams -
      // trying to push anything larger through to HomeKit is pointless, at least at this
      // time. Instead, to increase our chances of a smooth and quick playback experience,
      // we're going to set defaults that make sense within the context of HomeKit.
      let channelPriority;
      switch(camera.type) {
        // Handle very high-resolution cameras with more sane HomeKit defaults.
        case "UVC G4 Pro":
        case "UVC G4 Bullet":
          channelPriority = ["Medium", "Low", "High"];
          break;

        default:
          channelPriority = ["High", "Medium", "Low"];
          break;
      }

      // Iterate
      for(const quality of channelPriority) {
        const foundChannel = camera.channels.find(channel => {
          // No RTSP channel here.
          if(!channel.isRtspEnabled) {
            return false;
          }

          // Honor the user's quality biases.
          if(!nvr.optionEnabled(camera, "Stream." + quality)) {
            return false;
          }

          return channel.name === quality;
        });

        if(foundChannel) {
          newCameraQuality = foundChannel.name;
          newCameraUrl = foundChannel.rtspAlias;
          break;
        }
      }
    }

    // No RTSP stream is available.
    if(!newCameraUrl) {
      // Notify only if this is a new change.
      if(!this.isVideoConfigured || this.cameraUrl) {
        this.log("%s %s: No RTSP stream has been configured for this camera. %s",
          nvrApi.getNvrName(), nvrApi.getDeviceName(camera, this.accessory.displayName),
          "Enable an RTSP stream in the UniFi Protect webUI to resolve this issue or " +
          "assign the Administrator role to the user configured for this plugin to allow it to automatically configure itself."
        );
      }
    } else {
      // Set the selected quality.
      newCameraUrl = "rtsp://" + bootstrap.nvr.host + ":" + bootstrap.nvr.ports.rtsp + "/" + newCameraUrl;

      if(this.cameraUrl !== newCameraUrl) {
        this.log("%s %s: Stream quality configured: %s.", nvrApi.getNvrName(),
          nvrApi.getDeviceName(camera, this.accessory.displayName), newCameraQuality);
      }
    }

    // Set the video stream and shapshot URLs.
    this.cameraUrl = newCameraUrl;
    this.snapshotUrl = nvrApi.camerasUrl() + "/" + camera.id + "/snapshot";

    // Configure the video stream and inform HomeKit about it, if it's our first time.
    if(!this.isVideoConfigured) {
      this.isVideoConfigured = true;
      const streamingDelegate = new ProtectStreamingDelegate(this);
      this.accessory.configureController(streamingDelegate.controller);
    }

    return true;
  }
}
