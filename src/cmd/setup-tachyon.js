const CLICommandBase = require('./base');
const spinnerMixin = require('../lib/spinner-mixin');
const fs = require('fs-extra');
const ParticleApi = require('./api');
const settings = require('../../settings');
const createApiCache = require('../lib/api-cache');
const ApiClient = require('../lib/api-client');
const crypto = require('crypto');
const temp = require('temp').track();
const os = require('os');
const FlashCommand = require('./flash');
const CloudCommand = require('./cloud');
const { sha512crypt } = require('sha512crypt-node');
const DownloadManager = require('../lib/download-manager');
const { platformForId, PLATFORMS } = require('../lib/platform');
const path = require('path');
const { getEdlDevices } = require('particle-usb');
const { delay } = require('../lib/utilities');
const semver = require('semver');
const { prepareFlashFiles, getTachyonInfo } = require('../lib/tachyon-utils');


const DEVICE_READY_WAIT_TIME = 500; // ms
const showWelcomeMessage = (ui) => `
===================================================================================
			  Particle Tachyon Setup Command
===================================================================================

Welcome to the Particle Tachyon setup! This interactive command:

- Flashes your Tachyon device
- Configures it (password, WiFi credentials etc...)
- Connects it to the internet and the Particle Cloud!

${ui.chalk.bold('What you\'ll need:')}

1. Your Tachyon device
2. The Tachyon battery
3. A USB-C cable

${ui.chalk.bold('Important:')}
- This tool requires you to be logged into your Particle account.
- For more details, check out the documentation at: https://part.cl/setup-tachyon ${os.EOL}`;

module.exports = class SetupTachyonCommands extends CLICommandBase {
	constructor({ ui } = {}) {
		super();
		spinnerMixin(this);
		this._setupApi();
		this.ui = ui || this.ui;
		this.deviceId = null;
		this.outputLog = null;
		this.defaultOptions = {
			region: 'NA',
			version: 'latest',
			board: 'formfactor',
			variant: null,
			skipFlashingOs: false,
			skipCli: false,
			timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, // eslint-disable-line new-cap
			alwaysCleanCache: false
		};
		this.options = {};
	}


	async setup({ skip_flashing_os: skipFlashingOs, timezone, load_config: loadConfig, save_config: saveConfig, region, version, variant, board, skip_cli: skipCli } = {}) {
		const requiredFields = ['region', 'version', 'systemPassword', 'productId', 'timezone'];
		const options = { skipFlashingOs, timezone, loadConfig, saveConfig, region, version, variant, board, skipCli };
		await this.ui.write(showWelcomeMessage(this.ui));
		this.deviceId = await this._verifyDeviceInEDLMode();
		this.outputLog = path.join(process.cwd(), `tachyon_flash_${this.deviceId}_${Date.now()}.log`);
		await fs.ensureFile(this.outputLog);
		// get device info
		const deviceInfo = await this._getDeviceInfo();

		// step 1 login
		this._formatAndDisplaySteps("Okay—first up! Checking if you're logged in...", 1);
		await this._verifyLogin();
		// check if there is a config file
		const config = await this._loadConfig({ options, requiredFields, deviceInfo });
		config.isLocalVersion = this._validateVersion(config);

		if (config.silent) {
			this.ui.write(this.ui.chalk.bold(`Skipping to Step 5 - Using configuration file: ${loadConfig} ${os.EOL}`));
		} else {
			Object.assign(config, await this._getUserConfigurationStep()); // step 2
			config.productId = await this._getProductStep(); // step 3
			config.variant = await this._pickVariantStep(config); // step 4
		}

		config.apiServer = settings.apiUrl;
		config.server = settings.isStaging ? 'https://host-connect.staging.particle.io': 'https://host-connect.particle.io';
		config.verbose = settings.isStaging; // Extra logging if connected to staging

		config.packagePath = await this._downloadStep(config); // step 5
		config.registrationCode = await this._registerDeviceStep(config); // step 6
		const { xmlPath } = await this._configureConfigAndSaveStep(config); // step 7
		const flashSuccess = await this._flashStep(config.packagePath, xmlPath, config); // step 8
		await this._finalStep(flashSuccess, config); // step 9
	}

	async _verifyDeviceInEDLMode() {
		let edlDevices = [];
		let deviceId;
		let messageShown = false;
		while (edlDevices.length === 0) {
			try {
				edlDevices = await getEdlDevices();
				if (edlDevices.length > 0) {
					deviceId = edlDevices[0].id;
					break;
				}
				if (!messageShown) {
					const message = `${this.ui.chalk.bold('Before we get started, we need to power on your Tachyon board')}:` +
					`${os.EOL}${os.EOL}` +
					`1. Plug the USB-C cable into your computer and the Tachyon board.${os.EOL}` +
					`   The red light should turn on!${os.EOL}${os.EOL}` +
					`2. Put the Tachyon device into ${this.ui.chalk.bold('system update')} mode:${os.EOL}` +
					`   - Hold the button next to the red LED for 3 seconds.${os.EOL}` +
					`   - When the light starts flashing yellow, release the button.${os.EOL}`;
					this.ui.stdout.write(message);
					messageShown = true;
				}
			} catch (error) {
				// ignore error
			}
			await delay(DEVICE_READY_WAIT_TIME);
		}
		if (messageShown) {
			this.ui.stdout.write(`Your device is now in ${this.ui.chalk.bold('system update')} mode!${os.EOL}`);
			await delay(1000); // give the user a moment to read the message
		}
		return deviceId;
	}

	async _getDeviceInfo() {
		try {
			return await this.ui.showBusySpinnerUntilResolved('Getting device info', getTachyonInfo({
				outputLog: this.outputLog,
				ui: this.ui,
			}));
		} catch (error) {
			// ignore error and return default values
			this.ui.write('We couldn\'t get the device info.');
		}
	}

	async _verifyLogin() {
		const api = new ApiClient();
		try {
			api.ensureToken();
		} catch {
			const cloudCommand = new CloudCommand();
			await cloudCommand.login();
			this._setupApi();
		}
	}

	async _loadConfig({ options, requiredFields, deviceInfo }) {
		const configFromFile = await this._loadConfigFromFile(options.loadConfig);
		const optionsFromDevice = {};
		const cleanedOptions = Object.fromEntries(
			// eslint-disable-next-line no-unused-vars
			Object.entries(options).filter(([_, v]) => v !== undefined)
		);
		if (deviceInfo) {
			optionsFromDevice.region = deviceInfo.region.toLowerCase() !== 'unknown' ? deviceInfo.region : 'NA';
			optionsFromDevice.board = deviceInfo.osVersion === 'Ubuntu 20.04' ? 'formfactor_dvt' : 'formfactor';
		}
		const config = {
			...this.defaultOptions,
			...optionsFromDevice,
			...configFromFile,
			...cleanedOptions
		};

		// validate the config file if is silent
		if (configFromFile?.silent) {
			await this._validateConfig(config, requiredFields);
		}
		return config;
	}

	async _loadConfigFromFile(loadConfig) {
		if (loadConfig) {
			try {
				const data = fs.readFileSync(loadConfig, 'utf8');
				const config = JSON.parse(data);
				return { ...config, silent: true, loadedFromFile: true };
			} catch (error) {
				throw new Error(`The configuration file is not a valid JSON file: ${error.message}`);
			}
		}
	}

	async _validateConfig(config, requiredFields) {
		const missingFields = requiredFields.filter(field => !config[field]);
		if (missingFields.length) {
			const message = `The configuration file is missing required fields: ${missingFields.join(', ')}${os.EOL}`;
			this.ui.stdout.write(this.ui.chalk.red(message));
			this.ui.write(this.ui.chalk.red('Re-run the command with the correct configuration file.'));
			throw new Error('Not a valid configuration file');
		}
	}

	_validateVersion(config) {
		const isLocalVersion = this._isFile(config.version);
		if (!isLocalVersion && config.silent) {
			// validate we have board and variant
			if (!config.board || !config.variant) {
				throw new Error('Board and variant are required for silent mode');
			}
		}
		return isLocalVersion;
	}

	async _getUserConfigurationStep() {
		return this._runStepWithTiming(
			`Now lets capture some information about how you'd like your device to be configured when it first boots.${os.EOL}${os.EOL}` +
			`First, you'll be asked to set a password for the root account on your Tachyon device.${os.EOL}` +
			`Don't worry if you forget this—you can always reset your device later.${os.EOL}${os.EOL}` +
			`Finally you'll be prompted to provide an optional Wi-Fi network.${os.EOL}` +
			`While the 5G cellular connection will automatically connect, Wi-Fi is often much faster for use at home.${os.EOL}`,
			2,
			() => this._userConfiguration(),
			0
		);
	}

	async _userConfiguration() {
		const passwordAnswer = await this._getSystemPassword();
		const systemPassword = this._generateShadowCompatibleHash(passwordAnswer);
		const wifi = await this._getWifi();
		return { systemPassword, wifi };
	}

	async _getSystemPassword() {
		let password = '';
		while (password === '') {
			password = await this.ui.promptPasswordWithConfirmation({
				customMessage: 'Enter a password for the system account:',
				customConfirmationMessage: 'Re-enter the password for the system account:'
			});
			if (password === '') {
				this.ui.write('System password cannot be blank.');
			}
		}
		return password;
	}

	async _getWifi() {
		const question = [
			{
				type: 'input',
				name: 'setupWifi',
				message: 'Would you like to set up WiFi for your device? (y/n):',
				default: 'y',
			}
		];
		const { setupWifi } = await this.ui.prompt(question);
		if (setupWifi.toLowerCase() === 'y') {
			return this._getWifiCredentials();
		}

		return null;
	}

	async _getWifiCredentials() {
		const questions = [
			{
				type: 'input',
				name: 'ssid',
				message: 'Enter your WiFi SSID:'
			}
		];
		const res = await this.ui.prompt(questions);
		const password = await this.ui.promptPasswordWithConfirmation({
			customMessage: 'Enter your WiFi password:',
			customConfirmationMessage: 'Re-enter your WiFi password:'
		});

		return { ssid: res.ssid, password };
	}

	async _getProductStep() {
		return this._runStepWithTiming(
			`Next, let's select a Particle product for your Tachyon.${os.EOL}` +
			'A product will help manage the Tachyon device and keep things organized.',
			3,
			() => this._selectProduct()
		);
	}

	async _pickVariantStep(config) {
		if (config.isLocalVersion || config.variant) {
			this.ui.write(`Skipping to Step 5 - Using ${config.variant || config.version} operating system.${os.EOL}`);
			return;
		}
		const isRb3Board = config.board === 'rb3g2'; // RGB board
		let variantDescription = `Select the variant of the Tachyon operating system to set up.${os.EOL}`;
		if (isRb3Board) {
			variantDescription += 'The "preinstalled server" variant is for the RGB board.';
		} else {
			variantDescription += `The 'desktop' includes a GUI and is best for interacting with the device with a keyboard, mouse, and display.${os.EOL}`;
			variantDescription += "The 'headless' variant is for remote command line access only.";
		}
		return this._runStepWithTiming(
			variantDescription,
			4,
			() => this._selectVariant(isRb3Board)
		);
	}

	async _downloadStep(config) {
		return this._runStepWithTiming(
			`Next, we'll download the Tachyon Operating System image.${os.EOL}` +
			`Heads up: it's a large file — 3GB! Don't worry, though—the download will resume${os.EOL}` +
			`if it's interrupted. If you have to kill the CLI, it will pick up where it left. You can also${os.EOL}` +
			"just let it run in the background. We'll wait for you to be ready when its time to flash the device.",
			5,
			() => this._download(config)
		);
	}

	async _registerDeviceStep(config) {
		return this._runStepWithTiming(
			`Great! The download is complete.${os.EOL}` +
			"Now, let's register your product on the Particle platform.",
			6,
			() => this._getRegistrationCode(config.productId)
		);
	}

	async _configureConfigAndSaveStep(config) {
		const { path: configBlobPath, configBlob } = await this._runStepWithTiming(
			'Creating the configuration file to write to the Tachyon device...',
			7,
			() => this._createConfigBlob(config, this.deviceId)
		);

		const { xmlFile: xmlPath } = await prepareFlashFiles({
			logFile: this.outputLog,
			ui: this.ui,
			partitionsList: ['misc'],
			dir: path.dirname(configBlobPath),
			deviceId: this.deviceId,
			operation: 'program',
			checkFiles: true
		});
		// Save the config file if requested
		if (config.saveConfig) {
			await this._saveConfig(config, configBlob);
		}

		return { xmlPath };
	}

	async _flashStep(packagePath, xmlPath, config) {
		return this._runStepWithTiming(
			`Okay—last step! We're now flashing the device with the configuration, including the password, Wi-Fi settings, and operating system.${os.EOL}` +
			`Heads up: this is a large image and will take around 10 minutes to complete. Don't worry—we'll show a progress bar as we go!${os.EOL}${os.EOL}`,
			8,
			() => this._flash({
				files: [packagePath, xmlPath],
				skipFlashingOs: config.skipFlashingOs,
				skipReset: config.variant === 'desktop'
			})
		);
	}

	async _finalStep(flashSuccessful, config) { // TODO (hmontero): once we have the device in the cloud, we should show the device id
		if (flashSuccessful) {
			const { product } = await this.api.getProduct({ product: config.productId });
			const consoleUrl = `https://console${settings.isStaging ? '.staging' : ''}.particle.io`;
			if (config.variant === 'desktop') {
				this._formatAndDisplaySteps(
					`All done! Your Tachyon device is ready to boot to the desktop and will automatically connect to Wi-Fi.${os.EOL}${os.EOL}` +
					`To continue:${os.EOL}` +
					`  - Disconnect the USB-C cable${os.EOL}` +
					`  - Connect a USB-C Hub with an HDMI monitor, keyboard, and mouse.${os.EOL}` +
					`  - Power off the device by holding the power button for 3 seconds and releasing.${os.EOL}` +
					`  - Power on the device by pressing the power button.${os.EOL}${os.EOL}` +
					`When the device boots it will:${os.EOL}` +
					`  - Activate the built-in 5G modem.${os.EOL}` +
					`  - Connect to the Particle Cloud.${os.EOL}` +
					`  - Run all system services, including the desktop if an HDMI monitor is connected.${os.EOL}${os.EOL}` +
					`For more information about Tachyon, visit our developer site at: https://developer.particle.io!${os.EOL}` +
					`${os.EOL}` +
					`View your device on the Particle Console at: ${consoleUrl}/${product.slug}/devices/${this.deviceId}${os.EOL}`,
					9
				);
			} else {
				this._formatAndDisplaySteps(
					`All done! Your Tachyon device is now booting into the operating system and will automatically connect to Wi-Fi.${os.EOL}${os.EOL}` +
					`It will also:${os.EOL}` +
					`  - Activate the built-in 5G modem${os.EOL}` +
					`  - Connect to the Particle Cloud${os.EOL}` +
					`  - Run all system services, including battery charging${os.EOL}${os.EOL}` +
					`For more information about Tachyon, visit our developer site at: https://developer.particle.io!${os.EOL}` +
					`${os.EOL}` +
					`View your device on the Particle Console at: ${consoleUrl}/${product.slug}/devices/${this.deviceId}${os.EOL}`,
					9
				);
			}
		} else {
			this.ui.write(
				`${os.EOL}Flashing failed. Please unplug your device and rerun this. We're going to have to try it again.${os.EOL}` +
				`If it continues to fail, please select a different USB port or visit https://part.cl/setup-tachyon and the setup link for more information.${os.EOL}`
			);
		}
	}

	async _runStepWithTiming(stepDesc, stepNumber, asyncTask, minDuration = 2000) {
		this._formatAndDisplaySteps(stepDesc, stepNumber);

		const startTime = Date.now();

		try {
			const result = await asyncTask();
			const elapsed = Date.now() - startTime;

			if (elapsed < minDuration) {
				await new Promise((resolve) => setTimeout(resolve, minDuration - elapsed));
			}

			return result;
		} catch (err) {
			throw new Error(`Step ${stepNumber} failed with the following error: ${err.message}`);
		}
	}

	_formatAndDisplaySteps(text, step) {
		// Display the formatted step
		this.ui.write(`${os.EOL}===================================================================================${os.EOL}`);
		this.ui.write(`Step ${step}:${os.EOL}`);
		this.ui.write(`${text}${os.EOL}`);
	}

	async _selectVersion() {
		const question = [
			{
				type: 'input',
				name: 'version',
				message: 'Enter the version number:',
				default: 'latest',
			},
		];
		const answer = await this.ui.prompt(question);
		return answer.version;
	}

	async _selectVariant(isRb3Board) {
		const rgbVariantMapping = {
			'preinstalled server': 'preinstalled-server'
		};
		const tachyonVariantMapping = {
			'desktop (GUI)': 'desktop',
			'headless (command-line only)': 'headless'
		};
		const variantMapping = isRb3Board ? rgbVariantMapping : tachyonVariantMapping;
		const question = [
			{
				type: 'list',
				name: 'variant',
				message: 'Select the OS variant:',
				choices: Object.keys(variantMapping),
			},
		];
		const { variant } = await this.ui.prompt(question);
		return variantMapping[variant];
	}

	async _selectProduct() {
		const { orgSlug } = await this._getOrg();

		let productId = await this._getProduct(orgSlug);

		if (!productId) {
			productId = await this._createProduct({ orgSlug });
		}
		return productId;
	}

	async _getOrg() {
		const orgsResp = await this.api.getOrgs();
		const orgs = orgsResp.organizations;

		const orgName = orgs.length
			? await this._promptForOrg([...orgs.map(org => org.name), 'Sandbox'])
			: 'Sandbox';

		const orgSlug = orgName !== 'Sandbox' ? orgs.find(org => org.name === orgName).slug : null;
		return { orgName, orgSlug };
	}

	async _promptForOrg(choices) {
		const question = [
			{
				type: 'list',
				name: 'org',
				message: 'Select an organization:',
				choices,
			},
		];
		const { org } = await this.ui.prompt(question);
		return org;
	}

	async _getProduct(orgSlug) {
		const productsResp = await this.ui.showBusySpinnerUntilResolved(`Fetching products for ${orgSlug || 'sandbox'}`, this.api.getProducts(orgSlug));
		let newProductName = 'Create a new product';
		let products = productsResp?.products || [];


		products = products.filter((product) => platformForId(product.platform_id)?.name === 'tachyon');

		if (!products.length) {
			return null; // No products available
		}

		const selectedProductName = await this._promptForProduct([...products.map(product => product.name), newProductName]);

		const selectedProduct =  selectedProductName !== newProductName ? (products.find(p => p.name === selectedProductName)) : null;
		return selectedProduct?.id || null;
	}

	async _promptForProduct(choices) {
		const question = [
			{
				type: 'list',
				name: 'product',
				message: 'Select a product:',
				choices,
			},
		];
		const { product } = await this.ui.prompt(question);
		return product;
	}

	async _createProduct({ orgSlug }) {
		const platformId = PLATFORMS.find(p => p.name === 'tachyon').id;
		const question = [{
			type: 'input',
			name: 'productName',
			message: 'Enter the product name:',
			validate: (value) => {
				if (value.length === 0) {
					return 'You need to provide a product name';
				}
				return true;
			}
		}, {
			type: 'input',
			name: 'locationOptIn',
			message: 'Would you like to opt in to location services? (y/n):',
			default: 'y'
		}];
		const { productName, locationOptIn } = await this.ui.prompt(question);
		const { product } = await this.api.createProduct({
			name: productName,
			platformId,
			orgSlug,
			locationOptIn: locationOptIn.toLowerCase() === 'y'
		});
		this.ui.write(`Product ${product.name} created successfully!`);
		return product?.id;
	}


	async _download({ region, version, alwaysCleanCache, variant, board, isRb3Board, isLocalVersion }) {
		//before downloading a file, we need to check if 'version' is a local file or directory
		//if it is a local file or directory, we need to return the path to the file
		if (isLocalVersion) {
			return version;
		}

		const manager = new DownloadManager(this.ui);
		const manifest = await manager.fetchManifest({ version, isRb3Board });

		const build = manifest?.builds.find(build => build.region === region && build.variant === variant && build.board === board);
		if (!build) {
			throw new Error('No build available for the provided parameters');
		}
		const artifact = build.artifacts[0];
		const url = artifact.artifact_url;
		const outputFileName = url.replace(/.*\//, '');
		const expectedChecksum = artifact.sha256_checksum;

		return manager.download({ url, outputFileName, expectedChecksum, options: { alwaysCleanCache } });
	}

	async _getRegistrationCode(product) {
		const data = await this.api.getRegistrationCode(product);
		return data.registration_code;
	}

	async _createConfigBlob(_config, deviceId) {
		// Format the config and registration code into a config blob (JSON file, prefixed by the file size)
		const config = Object.fromEntries(
			Object.entries(_config).filter(([, value]) => value != null)
		);

		if (!config.skipCli) {
			const profileFile = settings.findOverridesFile();
			if (await fs.exists(profileFile)) {
				config.cliConfig = await fs.readFile(profileFile, 'utf8');
			}
		}

		// Write config JSON to a temporary file (generate a filename with the temp npm module)
		// prefixed by the JSON string length as a 32 bit integer
		let jsonString = JSON.stringify(config, null, 2);
		const buffer = Buffer.alloc(4 + Buffer.byteLength(jsonString));
		buffer.writeUInt32BE(Buffer.byteLength(jsonString), 0);
		buffer.write(jsonString, 4);
		const tempDir = await temp.mkdir('tachyon-config');
		const filePath = path.join(tempDir, `${deviceId}_misc.backup`);
		await fs.writeFile(filePath, buffer);

		return { path: filePath, configBlob: config };
	}

	_generateShadowCompatibleHash(password) {
		const salt = crypto.randomBytes(12).toString('base64');
		return sha512crypt(password, `$6$${salt}`);
	}

	async _flash({ files, skipFlashingOs, skipReset }) {
		const packagePath = files[0];
		const flashCommand = new FlashCommand();

		this.ui.write(`${os.EOL}Starting download. See logs at: ${this.outputLog}${os.EOL}`);
		if (!skipFlashingOs) {
			await flashCommand.flashTachyon({ files: [packagePath], skipReset: true, output: this.outputLog, verbose: false });
		}
		await flashCommand.flashTachyonXml({ files, skipReset, output: this.outputLog });
		return true;
	}

	async _saveConfig(config, configBlob) {
		const configFields = [
			'region',
			'version',
			'board',
			'variant',
			'skipCli',
			'systemPassword',
			'productId',
			'timezone',
			'wifi'
		];
		const configData = { ...config, ...configBlob };

		const savedConfig = Object.fromEntries(
			configFields
				.filter(key => key in configData && configData[key] !== null && configData[key] !== undefined)
				.map(key => [key, configData[key]])
		);
		await fs.writeFile(config.saveConfig, JSON.stringify(savedConfig, null, 2), 'utf-8');
		this.ui.write(`${os.EOL}Configuration file written here: ${config.saveConfig}${os.EOL}`);
	}

	_isFile(version) {
		const validChannels = ['latest', 'stable', 'beta', 'rc'];
		const isValidChannel = validChannels.includes(version);
		const isValidSemver = semver.valid(version);
		const isFile = !isValidChannel && !isValidSemver;

		// access(OK
		if (isFile) {
			try {
				fs.accessSync(version, fs.constants.F_OK | fs.constants.R_OK);
			} catch (error) {
				if (error.code === 'ENOENT') {
					throw new Error(`The file "${version}" does not exist.`);
				} else if (error.code === 'EACCES') {
					throw new Error(`The file "${version}" is not accessible (permission denied).`);
				}
				throw error;
			}
		}
		return isFile;
	}

	_particleApi() {
		const auth = settings.access_token;
		const api = new ParticleApi(settings.apiUrl, { accessToken: auth } );
		const apiCache = createApiCache(api);
		return { api: apiCache, auth };
	}

	_setupApi() {
		const { api } = this._particleApi();
		this.api = api;
	}
};
