const VError = require('verror');
const inquirer = require('inquirer');
const settings = require('../../settings');
const ApiClient = require('../lib/api-client');
const prompts = require('../lib/prompts');
const CloudCommand = require('./cloud');
const ParticleApi = require('./api');


module.exports = class AccessTokenCommands {
	getCredentials({ includeOTP = false } = {}) {
		if (!settings.username){
			return prompts.getCredentials();
		}

		const questions = [{
			type: 'password',
			name: 'password',
			message: 'Using account ' + settings.username + '\nPlease enter your password:'
		}];

		if (includeOTP){
			questions.push({
				type: 'input',
				name: 'otp',
				message: 'Please enter a login code [optional]'
			});
		}

		return inquirer.prompt(questions)
			.then((answers) => ({
				username: settings.username,
				password: answers.password,
				otp: answers.otp
			}));
	}

	/**
	 * @param {string[]} tokens
	 * @param {Object} options
	 * @param {boolean} options.force
	 * @returns {Promise<number | undefined>}
	 */
	async revokeAccessToken(tokens, { force }) {
		if (tokens.length === 0) {
			console.error('You must provide at least one access token to revoke');
			return -1;
		}

		if (tokens.indexOf(settings.access_token) >= 0) {
			console.log('WARNING: ' + settings.access_token + " is this CLI's access token");
			if (force) {
				console.log('**forcing**');
			} else {
				console.log('use --force to delete it');
				return -1;
			}
		}

		const particle = new ParticleApi(settings.apiUrl, { accessToken: settings.access_token });
		const results = await Promise.allSettled(
			tokens.map((token) => particle.revokeAccessToken(token))
		);

		const fails = results.filter((result) => result.status === 'rejected');
		if (fails.length > 0) {
			console.error('Failed to revoke the following access tokens:');
			fails.forEach((fail, i) => console.error(`  token: ${tokens[i]}; reason: ${fail.reason.message}`));
			return -1;
		}
		console.log('Successfully revoked all provided tokens');
	}

	/**
	 * Creates an access token using the given client name.
	 * @returns {Promise} Will print the access token to the console, along with the expiration date.
	 */
	createAccessToken ({ expiresIn, neverExpires }) {
		const clientName = 'user';

		const api = new ApiClient();

		if (neverExpires) {
			expiresIn = 0;
		}

		return Promise.resolve().then(() => {
			return this.getCredentials();
		}).then(creds => {
			return api.createAccessToken(clientName, creds.username, creds.password, expiresIn).catch((error) => {
				if (error.error === 'mfa_required') {
					const cloud = new CloudCommand();
					return cloud.enterOtp({ mfaToken: error.mfa_token });
				}
				throw error;
			});
		}).then(result => {
			if (result.expires_in) {
				const nowUnix = Date.now();
				const expiresUnix = nowUnix + (result.expires_in * 1000);
				const expiresDate = new Date(expiresUnix);
				console.log('New access token expires on ' + expiresDate);
			} else {
				console.log('New access token never expires');
			}
			console.log('    ' + result.access_token);
		}).catch(err => {
			throw new VError(api.normalizedApiError(err), 'Error while creating a new access token');
		});
	}
};

