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
const semver = require('semver');
const { prepareFlashFiles, getTachyonInfo, promptWifiNetworks, getEDLDevice } = require('../lib/tachyon-utils');
const { supportedCountries } = require('../lib/supported-countries');

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
${ui.chalk.bold(`${os.EOL}`)}
- This tool requires you to be logged into your Particle account.
- For more details, check out the documentation at: https://part.cl/setup-tachyon ${os.EOL}`;

module.exports = class SetupTachyonCommands extends CLICommandBase {
	constructor({ ui } = {}) {
		super();
		spinnerMixin(this);
		this._setupApi();
		this.ui = ui || this.ui;
		this.device = null;
		this._baseDir = settings.ensureFolder();
		this._logsDir = path.join(this._baseDir, 'logs');

		this.outputLog = null;
		this.defaultOptions = {
			region: 'NA',
			version: 'stable',
			board: 'formfactor',
			country: 'USA',
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
		// step 1 login
		this._formatAndDisplaySteps("Okay—first up! Checking if you're logged in...", 1);
		await this._verifyLogin();
		this.ui.write('');
		this.ui.write(`...All set! You're logged in as ${this.ui.chalk.bold(settings.username)} and ready to go!`);
		// step 2 get device info
		this._formatAndDisplaySteps("Now let's get the device info", 2);
		this.ui.write('');
		const device = await getEDLDevice({ ui: this.ui, showSetupMessage: true });
		this.device = device;
		// ensure logs dir
		await fs.ensureDir(this._logsDir);
		this.outputLog = path.join(this._logsDir, `tachyon_flash_${this.device.id}_${Date.now()}.log`);
		await fs.ensureFile(this.outputLog);
		this.ui.write(`${os.EOL}Starting Process. See logs at: ${this.outputLog}${os.EOL}`);
		const deviceInfo = await this._getDeviceInfo();
		this._printDeviceInfo(deviceInfo);
		// check if there is a config file
		const config = await this._loadConfig({ options, requiredFields, deviceInfo });
		config.isLocalVersion = this._validateVersion(config);

		if (config.silent) {
			this.ui.write(this.ui.chalk.bold(`Skipping to Step 5 - Using configuration file: ${loadConfig} ${os.EOL}`));
		} else {
			Object.assign(config, await this._getUserConfigurationStep()); // step 3
			config.productId = await this._getProductStep(); // step 4
			config.variant = await this._pickVariantStep(config); // step 5
			config.country = await this._getCountryStep(); // step 6
		}

		if (settings.isStaging) {
			config.apiServer = settings.apiUrl;
			config.server = 'https://edge.staging.particle.io';
			config.verbose = true;
		}

		config.packagePath = await this._downloadStep(config); // step 6
		this.product = await this._getProductDetails(config.productId);
		config.registrationCode = await this._registerDeviceStep(config); // step 7
		config.esim = await this._getESIMProfiles({ deviceId: this.device.id, country: config.country, productId: config.productId }); // after add device to product
		const { xmlPath } = await this._configureConfigAndSaveStep(config); // step 8
		const flashSuccess = await this._flashStep(config.packagePath, xmlPath, config); // step 9
		await this._finalStep(flashSuccess, config); // step 10
	}

	async _getDeviceInfo() {
		try {
			return await this.ui.showBusySpinnerUntilResolved('Getting device info', getTachyonInfo({
				outputLog: this.outputLog,
				ui: this.ui,
				device: this.device
			}));
		} catch (error) {
			// If this fails, the flash won't work so abort early.
			throw new Error('Unable to get device info. Please restart the device and try again.');
		}
	}

	async _printDeviceInfo(deviceInfo) {
		this.ui.write(this.ui.chalk.bold('Device info:'));
		this.ui.write(os.EOL);
		this.ui.write(` -  Device ID: ${deviceInfo.deviceId}`);
		if (deviceInfo.osVersion.includes('EVT')) {
			this.ui.write(' -  Board: EVT');
		}
		this.ui.write(` -  Region: ${deviceInfo.region}`);
		this.ui.write(` -  OS Version: ${deviceInfo.osVersion}`);
		let usbWarning = '';
		if (this.device.usbVersion.major <= 2) {
			usbWarning = this.ui.chalk.yellow(' (use a USB 3.0 port and USB-C cable for faster flashing)');
		}
		this.ui.write(` -  USB Version: ${this.device.usbVersion.major}.${this.device.usbVersion.minor}${usbWarning}`);
	}

	async _verifyLogin() {
		const api = new ApiClient();
		try {
			api.ensureToken();
			const currentToken = await api.getCurrentToken();
			const minRemainingTime = 60 * 60 * 1000; // 1 hour
			const expiresAt = currentToken.expires_at ? new Date(currentToken.expires_at) : null;
			if (expiresAt !== null && (expiresAt - Date.now()) < minRemainingTime) {
				throw new Error('Token expired or near to expire');
			}
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
				// remove board to prevent overwriting.
				delete config.board;
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
			`This same password is used for the user “particle”.${os.EOL}` +
			`Don't worry if you forget this—you can always reset your device later.${os.EOL}${os.EOL}` +
			`Finally you'll be prompted to provide a Wi-Fi network.${os.EOL}` +
			`This is needed to install the eSIM profile over the air so the device can connect to the 5G cellular network.${os.EOL}`,
			3,
			() => this._userConfiguration(),
			0
		);
	}

	async _userConfiguration() {
		const passwordAnswer = await this._getSystemPassword();
		const systemPassword = this._generateShadowCompatibleHash(passwordAnswer);
		const wifi = await this._getWifiConfiguration();
		return { systemPassword, wifi };
	}

	async _getWifiConfiguration() {
		this.ui.write(
			this.ui.chalk.bold(
				`${os.EOL}` +
				`Wi-Fi setup is required to continue when using Particle setup!${os.EOL}` +
				`This active internet connection is necessary to activate cellular connectivity on your device.${os.EOL}`
			)
		);
		return promptWifiNetworks(this.ui);
	}

	async _getSystemPassword() {
		let password = '';
		while (password === '') {
			password = await this.ui.promptPasswordWithConfirmation({
				customMessage: 'Enter a password for the root and particle accounts:',
				customConfirmationMessage: 'Re-enter the password for the root and particle accounts:'
			});
			if (password === '') {
				this.ui.write('System password cannot be blank.');
			}
		}
		return password;
	}


	async _getProductStep() {
		return this._runStepWithTiming(
			`Next, let's select a Particle product for your Tachyon.${os.EOL}` +
			'A product will help manage the Tachyon device and keep things organized.',
			4,
			() => this._selectProduct()
		);
	}

	async _getCountryStep() {
		return this._runStepWithTiming(
			`Next, let's configure the cellular connection for your Tachyon!.${os.EOL}` +
			'Select from the list of countries supported for the built in Particle cellular ' +
			`connection or select 'Other' if your country is not listed.${os.EOL}` +
			'For more information, visit: https://developer.particle.io/redirect/tachyon-cellular-setup',
			6,
			() => this._promptForCountry()
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
			variantDescription += "The 'headless' variant is accessed only by a terminal out of the box.";
		}
		return this._runStepWithTiming(
			variantDescription,
			5,
			() => this._selectVariant(isRb3Board)
		);
	}

	async _getESIMProfiles({ deviceId, country, productId }) {
		try {
			return await this.api.getESIMProfiles(deviceId, productId, country);
		} catch (error) {
			const message = `Error getting eSIM profiles: ${error.message}${os.EOL}`;
			this.ui.write(this.ui.chalk.yellow(message));
			return null;
		}
	}

	async _downloadStep(config) {
		return this._runStepWithTiming(
			`Next, we'll download the Tachyon Operating System image.${os.EOL}` +
			`Heads up: it's a large file — 3GB! Don't worry, though—the download will resume${os.EOL}` +
			`if it's interrupted. If you have to kill the CLI, it will pick up where it left. You can also${os.EOL}` +
			"just let it run in the background. We'll wait for you to be ready when its time to flash the device.",
			7,
			() => this._download(config)
		);
	}

	async _getProductDetails(productId) {
		const { product } = await this.api.getProduct({ product: productId });
		return product;
	}

	async _registerDeviceStep(config) {
		return this._runStepWithTiming(
			`Great! The download is complete.${os.EOL}` +
			"Now, let's register your product on the Particle platform.",
			8,
			() => this._getRegistrationCode(config.productId)
		);
	}

	async _configureConfigAndSaveStep(config) {
		const { path: configBlobPath, configBlob } = await this._runStepWithTiming(
			'Creating the configuration file to write to the Tachyon device...',
			9,
			() => this._createConfigBlob(config, this.device.id)
		);

		const { xmlFile: xmlPath } = await prepareFlashFiles({
			logFile: this.outputLog,
			ui: this.ui,
			partitionsList: ['misc'],
			dir: path.dirname(configBlobPath),
			deviceId: this.device.id,
			operation: 'program',
			checkFiles: true,
			device: this.device
		});
		// Save the config file if requested
		if (config.saveConfig) {
			await this._saveConfig(config, configBlob);
		}

		return { xmlPath };
	}

	async _flashStep(packagePath, xmlPath, config) {
		let message = `Heads up: this is a large image and flashing will take about 2 minutes to complete.${os.EOL}`;
		const slowUsb = this.device.usbVersion.major <= 2;
		if (slowUsb) {
			message = `Heads up: this is a large image and flashing will take about 8 minutes to complete.${os.EOL}` +
				this.ui.chalk.yellow(`${os.EOL}The device is connected to a slow USB port. Connect a USB Type-C cable directly to a USB 3.0 port to shorten this step to 2 minutes.${os.EOL}`);
		}

		return this._runStepWithTiming(
			`Okay—last step! We're now flashing the device with the configuration, including the password, Wi-Fi settings, and operating system.${os.EOL}` +
			message +
			`${os.EOL}` +
			`Meanwhile, you can explore the developer documentation at https://developer.particle.io${os.EOL}` +
      `${os.EOL}` +
			`You can also view your device on the Console at ${this._consoleLink()}${os.EOL}`,
			10,
			() => this._flash({
				files: [packagePath, xmlPath],
				skipFlashingOs: config.skipFlashingOs,
				skipReset: config.variant === 'desktop'
			})
		);
	}

	async _finalStep(flashSuccessful, config) { // TODO (hmontero): once we have the device in the cloud, we should show the device id
		if (flashSuccessful) {
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
					`View your device on the Particle Console at: ${this._consoleLink()}`,
					11
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
					`View your device on the Particle Console at: ${this._consoleLink()}`,
					11
				);
			}
		} else {
			this.ui.write(
				`${os.EOL}Flashing failed. Please unplug your device and rerun this. We're going to have to try it again.${os.EOL}` +
				`If it continues to fail, please select a different USB port or visit https://part.cl/setup-tachyon and the setup link for more information.${os.EOL}`
			);
		}
	}

	_consoleLink() {
		const baseUrl = `https://console${settings.isStaging ? '.staging' : ''}.particle.io`;
		return `${baseUrl}/${this.product.slug}/devices/${this.device.id}`;
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
		this.ui.write(`${text}`);
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

	async _promptForCountry() {
		// check if the country is already set
		const defaultCountry = settings.profile_json.country || this.defaultOptions.country;

		const question = [
			{
				type: 'list',
				name: 'countryCode',
				message: 'Select your country:',
				choices: [...supportedCountries, new this.ui.Separator()],
				default: defaultCountry
			},
		];
		const { countryCode } = await this.ui.prompt(question);
		settings.profile_json.country = countryCode;
		settings.saveProfileData();
		if (countryCode === 'OTHER') {
			this.ui.write('No cellular profile will be enabled for your device');
		}
		return countryCode;
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
		this._printOSInfo(build);
		const url = artifact.artifact_url;
		const outputFileName = url.replace(/.*\//, '');
		const expectedChecksum = artifact.sha256_checksum;

		return manager.download({ url, outputFileName, expectedChecksum, options: { alwaysCleanCache } });
	}

	_printOSInfo(build) {
		const { distribution, variant, distribution_version: distributionVersion, version, region } = build;
		this.ui.write(this.ui.chalk.bold('Operating system information:'));
		this.ui.write(this.ui.chalk.bold(`Tachyon ${distribution} ${distributionVersion} (${variant}, ${region} region)`));
		this.ui.write(`${this.ui.chalk.bold('Version:')} ${version}`);
	}

	async _getRegistrationCode(productId) {
		await this._assignDeviceToProduct({ productId: productId, deviceId: this.device.id });
		const data = await this.api.getRegistrationCode({ productId, deviceId: this.device.id });
		return data.registration_code;
	}

	async _assignDeviceToProduct({ deviceId, productId }) {
		const data = await this.api.addDeviceToProduct(deviceId, productId);
		if (data.updatedDeviceIds.length === 0 && data.existingDeviceIds.length === 0) {
			let errorDescription = '';
			if (data.invalidDeviceIds.length > 0) {
				errorDescription = ': Invalid device ID';
			}
			if (data.nonmemberDeviceIds.length > 0) {
				errorDescription = ': Device is owned by another user';
			}
			throw new Error(`Failed to assign device ${deviceId} ${errorDescription}`);
		}
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
		// inject initial time
		config['initialTime'] = new Date().toISOString();

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
		// crypt uses . instead of + for base64
		const salt = crypto.randomBytes(12).toString('base64').replaceAll('+', '.');
		return sha512crypt(password, `$6$${salt}`);
	}

	async _flash({ files, skipFlashingOs, skipReset }) {
		const packagePath = files[0];
		const flashCommand = new FlashCommand();

		if (!skipFlashingOs) {
			await flashCommand.flashTachyon({ device: this.device, files: [packagePath], skipReset: true, output: this.outputLog, verbose: false });
		}
		await flashCommand.flashTachyonXml({ device: this.device, files, skipReset, output: this.outputLog });
		return true;
	}

	async _saveConfig(config, configBlob) {
		const configFields = [
			'region',
			'version',
			'variant',
			'skipCli',
			'systemPassword',
			'productId',
			'timezone',
			'wifi',
			'country',
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
