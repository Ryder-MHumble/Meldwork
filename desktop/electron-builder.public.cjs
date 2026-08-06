const { build } = require('./package.json')

module.exports = {
  ...build,
  forceCodeSigning: true,
  afterSign: 'scripts/after-sign.cjs',
  mac: {
    ...build.mac,
    notarize: true,
  },
}
