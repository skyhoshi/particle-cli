const os = require('os');
const path = require('path');
const execa = require('execa');
const cli = require('../lib/cli');
const fs = require('../lib/fs');
const {
	USERNAME,
	PASSWORD,
	DEVICE_ID,
	DEVICE_NAME,
	DEVICE_PLATFORM_ID,
	DEVICE_PLATFORM_NAME,
	PATH_FIXTURES_PKG_DIR,
	PATH_REPO_DIR,
	PATH_HOME_DIR,
	PATH_TMP_DIR
} = require('../lib/env');
const { version } = require('../../package.json');
const NPM_PACKAGE_PATH = path.join(__dirname, '..', '..', `particle-cli-${version}.tgz`);

const builds = {
	'darwin-x64': 'particle-cli',
	'linux-x64': 'particle-cli',
	'win32-x64': 'particle-cli.exe',
	'darwin-arm64': 'particle-cli',
};


if (os.userInfo().homedir === os.homedir()){
	throw new Error([
		'\n',
		'::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::',
		':::: Cannot write to default $HOME directory - Please override! ::::',
		':::: See: ./test/lib/.env.js :::::::::::::::::::::::::::::::::::::::',
		'::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::',
		'\n'
	].join('\n'));
}

if (!USERNAME || !PASSWORD || !DEVICE_ID || !DEVICE_NAME || !DEVICE_PLATFORM_ID || !DEVICE_PLATFORM_NAME){
	throw new Error([
		'\n',
		'::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::',
		':::: End-To-End test configuration is missing or invalid! ::::::::::',
		':::: For setup instructions, see: ./test/README.md :::::::::::::::::',
		'::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::',
		'\n'
	].join('\n'));
}

before(async () => {
	const particleCliDir = path.join(PATH_FIXTURES_PKG_DIR, 'node_modules', '.bin');
	await Promise.all(
		[PATH_HOME_DIR, PATH_TMP_DIR, particleCliDir]
			.map(dir => fs.ensureDir(dir)
				.then(() => fs.emptyDir(dir)))
	);

	const osKey = `${os.platform()}-${os.arch()}`;
	const cliName = builds[osKey];
	const appName = os.platform() === 'win32' ? 'particle.exe' : 'particle';
	await execa('cp', [path.join(PATH_REPO_DIR, 'build', cliName), path.join(PATH_FIXTURES_PKG_DIR, 'node_modules', '.bin', appName)]);
});

afterEach(async () => {
	await fs.emptyDir(PATH_TMP_DIR);
});

after(async () => {
	await cli.logout();
	await cli.setDefaultProfile();
	await fs.remove(NPM_PACKAGE_PATH);
	await fs.remove(path.join(PATH_FIXTURES_PKG_DIR, 'node_modules'));
});

