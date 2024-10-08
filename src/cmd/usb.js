const { asyncMapSeries, buildDeviceFilter } = require('../lib/utilities');
const { getDevice, formatDeviceInfo } = require('./device-util');
const { getUsbDevices, openUsbDevice, TimeoutError, DeviceProtectionError, forEachUsbDevice, executeWithUsbDevice } = require('./usb-util');
const { systemSupportsUdev, udevRulesInstalled, installUdevRules } = require('./udev');
const { platformForId, isKnownPlatformId } = require('../lib/platform');
const ParticleApi = require('./api');
const spinnerMixin = require('../lib/spinner-mixin');
const CLICommandBase = require('./base');
const chalk = require('chalk');

module.exports = class UsbCommand extends CLICommandBase {
	constructor(settings) {
		super();
		spinnerMixin(this);
		this._auth = settings.access_token;
		this._api = new ParticleApi(settings.apiUrl, { accessToken: this._auth }).api;
	}

	list(args) {
		const idsOnly = args['ids-only'];
		const excludeDfu = args['exclude-dfu'];
		const filter = args.params.filter;

		const filterFunc = buildDeviceFilter(filter);

		// Enumerate USB devices
		return getUsbDevices({ dfuMode: !excludeDfu })
			.then(usbDevices => {
				if (usbDevices.length === 0) {
					return [];
				}
				// Get device info
				return asyncMapSeries(usbDevices, (usbDevice) => {
					return openUsbDevice(usbDevice, { dfuMode: true })
						.then(() => {
							if (!idsOnly) {
								return getDevice({
									id: usbDevice.id,
									api: this._api,
									auth: this._auth,
									dontThrow: true
								});
							}
						})
						.then(device => {
							let info = [device, usbDevice.isInDfuMode];

							if (!usbDevice.isInDfuMode){
								info.push(
									usbDevice.getDeviceMode({ timeout: 10 * 1000 })
										.catch(error => {
											if (error instanceof TimeoutError) {
												return 'UNKNOWN';
											} else if (error instanceof DeviceProtectionError) {
												return 'PROTECTED';
											}
											throw error;
										})
								);
							}

							return Promise.all(info);
						})
						.then(([device, isInDfuMode, mode]) => {
							const { name, platform_id: platformID, connected } = device || {};
							const platform = isKnownPlatformId(usbDevice.platformId) ? platformForId(usbDevice.platformId).displayName :
								`Platform ${usbDevice.platformId}`;
							const type = [platform];

							if (isInDfuMode){
								type.push('DFU');
							}

							if (mode && (mode !== 'UNKNOWN' && mode !== 'NORMAL')){
								type.push(mode);
							}

							return {
								id: usbDevice.id,
								name: name || '',
								type: `${type.join(', ')}`,
								platform_id: platformID || usbDevice.platformId,
								connected: !!connected
							};
						})
						.finally(() => usbDevice.close());
				});
			})
			.then(devices => {
				if (idsOnly) {
					devices.forEach(device => console.log(device.id));
				} else {
					if (devices.length === 0) {
						console.log('No devices found.');
					} else {
						devices = devices.sort((a, b) => a.name.localeCompare(b.name)); // Sort devices by name

						if (filter) {
							devices = devices.filter(filterFunc);
						}
						devices.forEach(device => {
							console.log(formatDeviceInfo(device));
						});
					}
				}
			});
	}

	startListening(args) {
		args.api = this._api;
		args.auth = this._auth;
		return forEachUsbDevice(args, usbDevice => {
			return usbDevice.enterListeningMode();
		})
			.then(() => {
				console.log('Done.');
			});
	}

	stopListening(args) {
		args.api = this._api;
		args.auth = this._auth;
		return forEachUsbDevice(args, usbDevice => {
			return usbDevice.leaveListeningMode();
		})
			.then(() => {
				console.log('Done.');
			});
	}

	safeMode(args) {
		args.api = this._api;
		args.auth = this._auth;
		return forEachUsbDevice(args, usbDevice => {
			return usbDevice.enterSafeMode();
		})
			.then(() => {
				console.log('Done.');
			});
	}

	dfu(args) {
		args.api = this._api;
		args.auth = this._auth;
		return forEachUsbDevice(args, usbDevice => {
			if (!usbDevice.isInDfuMode) {
				return usbDevice.enterDfuMode();
			}
		}, { dfuMode: true })
			.then(() => {
				console.log('Done.');
			});
	}

	reset(args) {
		args.api = this._api;
		args.auth = this._auth;
		return forEachUsbDevice(args, usbDevice => {
			return usbDevice.reset();
		}, { dfuMode: true })
			.then(() => {
				console.log('Done.');
			});
	}

	async setSetupDone(args) {
		args.api = this._api;
		args.auth = this._auth;
		const done = !args.reset;

		const processDevice = async (usbDevice) => {
			if (usbDevice.isGen3Device) {
				await usbDevice.setSetupDone(done);

				if (done) {
					await usbDevice.leaveListeningMode();
				} else {
					await usbDevice.enterListeningMode();
				}
			}
		};

		await forEachUsbDevice(args, processDevice);
		console.log('Done.');
	}

	configure() {
		if (!systemSupportsUdev()) {
			console.log('The system does not require configuration.');
			return Promise.resolve();
		}
		if (udevRulesInstalled()) {
			console.log('The system is already configured.');
			return Promise.resolve();
		}
		return installUdevRules()
			.then(() => console.log('Done.'));
	}

	async cloudStatus(args) {
		const { until, timeout, params: { device } } = args;
		await executeWithUsbDevice({
			args: { idOrName: device, api: this._api, auth: this._auth }, // device here is the id
			func: (dev) => this._cloudStatus(dev, until, timeout),
			dfuMode: false
		});
	}

	async _cloudStatus(device, until, timeout) {
		let status = null;

		this.newSpin('Querying device...').start();
		if (!until) {
			status = await device.getCloudConnectionStatus();
			this.stopSpin();
			console.log(status.toLowerCase());
			return;
		}

		const endTime = Date.now() + timeout;

		while (Date.now() < endTime) {
			try {
				status = await device.getCloudConnectionStatus();
				if (status.toLowerCase() === until) {
					this.stopSpin();
					console.log(status.toLowerCase());
					return;
				}
			} catch (error) {
				// Ignore error and continue polling
			}
		}

		this.stopSpin();
		throw new Error('Timed out waiting for status');
	}

	// Helper function to convert CIDR notation to netmask to imitate the 'ifconfig' output
	_cidrToNetmask(cidr) {
		let mask = [];

		// Calculate number of full '1' octets in the netmask
		for (let i = 0; i < Math.floor(cidr / 8); i++) {
			mask.push(255);
		}

		// Calculate remaining bits in the next octet
		if (mask.length < 4) {
			mask.push((256 - Math.pow(2, 8 - cidr % 8)) & 255);
		}

		// Fill the remaining octets with '0' if any
		while (mask.length < 4) {
			mask.push(0);
		}

		return mask.join('.');
	}

	async getNetworkIfaces(args) {
		// define output array with logs to prevent interleaving with the spinner
		let output = [];
		args.api = this._api;
		args.auth = this._auth;

		await forEachUsbDevice(args, usbDevice => {
			const platform = platformForId(usbDevice.platformId);
			return this.getNetworkIfaceInfo(usbDevice)
				.then((nwIfaces) => {
					const outputData = this._formatNetworkIfaceOutput(nwIfaces, platform.displayName, usbDevice.id);
					output = output.concat(outputData);
				})
				.catch((error) => {
					output = output.concat(`Error getting network interfaces (${platform.displayName} / ${usbDevice.id}): ${error.message}\n`);
				});
		});

		if (output.length === 0) {
			console.log('No network interfaces found.');
		}
		output.forEach((str) => console.log(str));
	}

	async getNetworkIfaceInfo(usbDevice) {
		let nwIfaces = [];
		const ifaceList = await usbDevice.getNetworkInterfaceList();
		for (const iface of ifaceList) {
			const ifaceInfo = await usbDevice.getNetworkInterface({ index: iface.index, timeout: 10000 });
			nwIfaces.push(ifaceInfo);
		}
		return nwIfaces;
	}

	_formatNetworkIfaceOutput(nwIfaces, platform, deviceId) {
		const output = [];
		output.push(`Device ID: ${chalk.cyan(deviceId)} (${chalk.cyan(platform)})`);
		for (const ifaceInfo of nwIfaces) {
			const flagsStr = ifaceInfo.flagsStrings.join(',');
			output.push(`\t${ifaceInfo.name}(${ifaceInfo.type}): flags=${ifaceInfo.flagsVal}<${flagsStr}> mtu ${ifaceInfo.mtu}`);

			// Process IPv4 addresses
			if (ifaceInfo?.ipv4Config?.addresses.length > 0) {
				for (const address of ifaceInfo.ipv4Config.addresses) {
					const [ipv4Address, cidrBits] = address.split('/');
					const ipv4NetMask = this._cidrToNetmask(parseInt(cidrBits, 10));
					output.push(`\t\tinet ${ipv4Address} netmask ${ipv4NetMask}`);
				}
			}

			// Process IPv6 addresses
			if (ifaceInfo?.ipv6Config?.addresses.length > 0) {
				for (const address of ifaceInfo.ipv6Config.addresses) {
					const [ipv6Address, ipv6Prefix] = address.split('/');
					output.push(`\t\tinet6 ${ipv6Address} prefixlen ${ipv6Prefix}`);
				}
			}

			// Process hardware address
			if (ifaceInfo?.hwAddress) {
				output.push(`\t\tether ${ifaceInfo.hwAddress}`);
			}
		}
		return output;
	}

};

