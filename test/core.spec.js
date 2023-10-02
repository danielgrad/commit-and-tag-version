/* global describe it afterEach */

'use strict'

const shell = require('shelljs')
const fs = require('fs')
const { resolve } = require('path')
const { Readable } = require('stream')
const mockFS = require('mock-fs')
const mockery = require('mockery')
const stdMocks = require('std-mocks')
const stripAnsi = require('strip-ansi')

const cli = require('../command')
const formatCommitMessage = require('../lib/format-commit-message')

const chai = require('chai')
const should = chai.should()
const expect = chai.expect
chai.use(require('chai-as-promised'))

// set by mock()
let standardVersion

function exec (opt = '', git) {
  if (typeof opt === 'string') {
    opt = cli.parse(`commit-and-tag-version ${opt}`)
  }
  if (!git) opt.skip = Object.assign({}, opt.skip, { commit: true, tag: true })
  return standardVersion(opt)
}

function getPackageVersion () {
  return JSON.parse(fs.readFileSync('package.json', 'utf-8')).version
}

/**
 * Mock external conventional-changelog modules
 *
 * Mocks should be unregistered in test cleanup by calling unmock()
 *
 * bump?: 'major' | 'minor' | 'patch' | Error | (opt, parserOpts, cb) => { cb(err) | cb(null, { releaseType }) }
 * changelog?: string | Error | Array<string | Error | (opt) => string | null>
 * execFile?: ({ dryRun, silent }, cmd, cmdArgs) => Promise<string>
 * fs?: { [string]: string | Buffer | any }
 * pkg?: { [string]: any }
 * tags?: string[] | Error
 */
function mock ({ bump, changelog, execFile, fs, pkg, tags } = {}) {
  mockery.enable({ warnOnUnregistered: false, useCleanCache: true })

  mockery.registerMock('conventional-recommended-bump', function (opt, parserOpts, cb) {
    if (typeof bump === 'function') bump(opt, parserOpts, cb)
    else if (bump instanceof Error) cb(bump)
    else cb(null, bump ? { releaseType: bump } : {})
  })

  if (!Array.isArray(changelog)) changelog = [changelog]
  mockery.registerMock(
    'conventional-changelog',
    (opt) =>
      new Readable({
        read (_size) {
          const next = changelog.shift()
          if (next instanceof Error) {
            this.destroy(next)
          } else if (typeof next === 'function') {
            this.push(next(opt))
          } else {
            this.push(next ? Buffer.from(next, 'utf8') : null)
          }
        }
      })
  )

  mockery.registerMock('git-semver-tags', function (cb) {
    if (tags instanceof Error) cb(tags)
    else cb(null, tags | [])
  })

  if (typeof execFile === 'function') {
    // called from commit & tag lifecycle methods
    mockery.registerMock('../run-execFile', execFile)
  }

  // needs to be set after mockery, but before mock-fs
  standardVersion = require('../index')

  fs = Object.assign({}, fs)
  if (pkg) {
    fs['package.json'] = JSON.stringify(pkg)
  } else if (pkg === undefined && !fs['package.json']) {
    fs['package.json'] = JSON.stringify({ version: '1.0.0' })
  }
  mockFS(fs)

  stdMocks.use()
  return () => stdMocks.flush()
}

function unmock () {
  mockery.deregisterAll()
  mockery.disable()
  mockFS.restore()
  stdMocks.restore()
  standardVersion = null

  // push out prints from the Mocha reporter
  const { stdout } = stdMocks.flush()
  for (const str of stdout) {
    if (str.startsWith(' ')) process.stdout.write(str)
  }
}

describe('format-commit-message', function () {
  it('works for no {{currentTag}}', function () {
    formatCommitMessage('chore(release): 1.0.0', '1.0.0').should.equal(
      'chore(release): 1.0.0'
    )
  })
  it('works for one {{currentTag}}', function () {
    formatCommitMessage('chore(release): {{currentTag}}', '1.0.0').should.equal(
      'chore(release): 1.0.0'
    )
  })
  it('works for two {{currentTag}}', function () {
    formatCommitMessage(
      'chore(release): {{currentTag}} \n\n* CHANGELOG: https://github.com/absolute-version/commit-and-tag-version/blob/v{{currentTag}}/CHANGELOG.md',
      '1.0.0'
    ).should.equal(
      'chore(release): 1.0.0 \n\n* CHANGELOG: https://github.com/absolute-version/commit-and-tag-version/blob/v1.0.0/CHANGELOG.md'
    )
  })
})

describe('cli', function () {
  afterEach(unmock)

  describe('CHANGELOG.md does not exist', function () {
    it('populates changelog with commits since last tag by default', async function () {
      mock({ bump: 'patch', changelog: 'patch release\n', tags: ['v1.0.0'] })
      await exec()
      const content = fs.readFileSync('CHANGELOG.md', 'utf-8')
      content.should.match(/patch release/)
    })

    it('includes all commits if --first-release is true', async function () {
      mock({
        bump: 'minor',
        changelog: 'first commit\npatch release\n',
        pkg: { version: '1.0.1' }
      })
      await exec('--first-release')
      const content = fs.readFileSync('CHANGELOG.md', 'utf-8')
      content.should.match(/patch release/)
      content.should.match(/first commit/)
    })

    it('skipping changelog will not create a changelog file', async function () {
      mock({ bump: 'minor', changelog: 'foo\n' })
      await exec('--skip.changelog true')
      getPackageVersion().should.equal('1.1.0')
      expect(() => fs.readFileSync('CHANGELOG.md', 'utf-8')).to.throw(/ENOENT/)
    })
  })

  describe('CHANGELOG.md exists', function () {
    it('appends the new release above the last release, removing the old header (legacy format)', async function () {
      mock({
        bump: 'patch',
        changelog: 'release 1.0.1\n',
        fs: { 'CHANGELOG.md': 'legacy header format<a name="1.0.0">\n' },
        tags: ['v1.0.0']
      })
      await exec()
      const content = fs.readFileSync('CHANGELOG.md', 'utf-8')
      content.should.match(/1\.0\.1/)
      content.should.not.match(/legacy header format/)
    })

    it('appends the new release above the last release, removing the old header (new format)', async function () {
      const { header } = require('../defaults')
      const changelog1 =
        '### [1.0.1](/compare/v1.0.0...v1.0.1) (YYYY-MM-DD)\n\n\n### Bug Fixes\n\n* patch release ABCDEFXY\n'
      mock({ bump: 'patch', changelog: changelog1, tags: ['v1.0.0'] })
      await exec()
      let content = fs.readFileSync('CHANGELOG.md', 'utf-8')
      content.should.equal(header + '\n' + changelog1)

      const changelog2 =
        '### [1.0.2](/compare/v1.0.1...v1.0.2) (YYYY-MM-DD)\n\n\n### Bug Fixes\n\n* another patch release ABCDEFXY\n'
      unmock()
      mock({
        bump: 'patch',
        changelog: changelog2,
        fs: { 'CHANGELOG.md': content },
        tags: ['v1.0.0', 'v1.0.1']
      })
      await exec()
      content = fs.readFileSync('CHANGELOG.md', 'utf-8')
      content.should.equal(header + '\n' + changelog2 + changelog1)
    })

    it('[DEPRECATED] (--changelogHeader) allows for a custom changelog header', async function () {
      const header = '# Pork Chop Log'
      mock({
        bump: 'minor',
        changelog: header + '\n',
        fs: { 'CHANGELOG.md': '' }
      })
      await exec(`--changelogHeader="${header}"`)
      const content = fs.readFileSync('CHANGELOG.md', 'utf-8')
      content.should.match(new RegExp(header))
    })

    it('[DEPRECATED] (--changelogHeader) exits with error if changelog header matches last version search regex', async function () {
      mock({ bump: 'minor', fs: { 'CHANGELOG.md': '' } })
      expect(exec('--changelogHeader="## 3.0.2"')).to.be.rejectedWith(/custom changelog header must not match/)
    })
  })

  describe('lifecycle scripts', () => {
    describe('prerelease hook', function () {
      it('should run the prerelease hook when provided', async function () {
        const flush = mock({
          bump: 'minor',
          fs: { 'CHANGELOG.md': 'legacy header format<a name="1.0.0">\n' }
        })

        await exec({
          scripts: {
            prerelease: "node -e \"console.error('prerelease' + ' ran')\""
          }
        })
        const { stderr } = flush()
        stderr.join('\n').should.match(/prerelease ran/)
      })

      it('should abort if the hook returns a non-zero exit code', async function () {
        mock({
          bump: 'minor',
          fs: { 'CHANGELOG.md': 'legacy header format<a name="1.0.0">\n' }
        })

        expect(exec({
          scripts: {
            prerelease: "node -e \"throw new Error('prerelease' + ' fail')\""
          }
        })).to.be.rejectedWith(/prerelease fail/)
      })
    })

    describe('prebump hook', function () {
      it('should allow prebump hook to return an alternate version #', async function () {
        const flush = mock({
          bump: 'minor',
          fs: { 'CHANGELOG.md': 'legacy header format<a name="1.0.0">\n' }
        })

        await exec({
          scripts: {
            prebump: "node -e \"console.log(Array.of(9, 9, 9).join('.'))\""
          }
        })
        const { stdout } = flush()
        stdout.join('').should.match(/9\.9\.9/)
        getPackageVersion().should.equal('9.9.9')
      })

      it('should not allow prebump hook to return a releaseAs command', async function () {
        mock({
          bump: 'minor',
          fs: { 'CHANGELOG.md': 'legacy header format<a name="1.0.0">\n' }
        })

        await exec({
          scripts: {
            prebump: "node -e \"console.log('major')\""
          }
        })
        getPackageVersion().should.equal('1.1.0')
      })

      it('should allow prebump hook to return an arbitrary string', async function () {
        mock({
          bump: 'minor',
          fs: { 'CHANGELOG.md': 'legacy header format<a name="1.0.0">\n' }
        })

        await exec({
          scripts: {
            prebump: "node -e \"console.log('Hello World')\""
          }
        })
        getPackageVersion().should.equal('1.1.0')
      })

      it('should allow prebump hook to return a version with build info', async function () {
        mock({
          bump: 'minor',
          fs: { 'CHANGELOG.md': 'legacy header format<a name="1.0.0">\n' }
        })

        await exec({
          scripts: {
            prebump: "node -e \"console.log('9.9.9-test+build')\""
          }
        })
        getPackageVersion().should.equal('9.9.9-test+build')
      })
    })

    describe('postbump hook', function () {
      it('should run the postbump hook when provided', async function () {
        const flush = mock({
          bump: 'minor',
          fs: { 'CHANGELOG.md': 'legacy header format<a name="1.0.0">\n' }
        })

        await exec({
          scripts: {
            postbump: "node -e \"console.error('postbump' + ' ran')\""
          }
        })
        const { stderr } = flush()
        stderr.join('\n').should.match(/postbump ran/)
      })

      it('should run the postbump and exit with error when postbump fails', async function () {
        mock({
          bump: 'minor',
          fs: { 'CHANGELOG.md': 'legacy header format<a name="1.0.0">\n' }
        })

        expect(exec({
          scripts: {
            postbump: "node -e \"throw new Error('postbump' + ' fail')\""
          }
        })).to.be.rejectedWith(/postbump fail/)
        expect(exec('--patch')).to.be.rejectedWith(/postbump fail/)
      })
    })
  })

  describe('manual-release', function () {
    describe('release-types', function () {
      const regularTypes = ['major', 'minor', 'patch']
      const nextVersion = { major: '2.0.0', minor: '1.1.0', patch: '1.0.1' }

      regularTypes.forEach(function (type) {
        it('creates a ' + type + ' release', async function () {
          mock({
            bump: 'patch',
            fs: { 'CHANGELOG.md': 'legacy header format<a name="1.0.0">\n' }
          })
          await exec('--release-as ' + type)
          getPackageVersion().should.equal(nextVersion[type])
        })
      })

      // this is for pre-releases
      regularTypes.forEach(function (type) {
        it('creates a pre' + type + ' release', async function () {
          mock({
            bump: 'patch',
            fs: { 'CHANGELOG.md': 'legacy header format<a name="1.0.0">\n' }
          })
          await exec('--release-as ' + type + ' --prerelease ' + type)
          getPackageVersion().should.equal(`${nextVersion[type]}-${type}.0`)
        })
      })

      it('exits with error if an invalid release type is provided', async function () {
        mock({ bump: 'minor', fs: { 'CHANGELOG.md': '' } })

        expect(exec('--release-as invalid')).to.be.rejectedWith(/releaseAs must be one of/)
      })
    })

    describe('release-as-exact', function () {
      it('releases as v100.0.0', async function () {
        mock({
          bump: 'patch',
          fs: { 'CHANGELOG.md': 'legacy header format<a name="1.0.0">\n' }
        })
        await exec('--release-as v100.0.0')
        getPackageVersion().should.equal('100.0.0')
      })

      it('releases as 200.0.0-amazing', async function () {
        mock({
          bump: 'patch',
          fs: { 'CHANGELOG.md': 'legacy header format<a name="1.0.0">\n' }
        })
        await exec('--release-as 200.0.0-amazing')
        getPackageVersion().should.equal('200.0.0-amazing')
      })

      it('releases as 100.0.0 with prerelease amazing', async function () {
        mock({
          bump: 'patch',
          fs: { 'CHANGELOG.md': 'legacy header format<a name="1.0.0">\n' },
          pkg: {
            version: '1.0.0'
          }
        })
        await exec('--release-as 100.0.0 --prerelease amazing')
        should.equal(getPackageVersion(), '100.0.0-amazing.0')
      })

      it('release 100.0.0 with prerelease amazing bumps build', async function () {
        mock({
          bump: 'patch',
          fs: { 'CHANGELOG.md': 'legacy header format<a name="100.0.0-amazing.0">\n' },
          pkg: {
            version: '100.0.0-amazing.0'
          }
        })
        await exec('--release-as 100.0.0 --prerelease amazing')
        should.equal(getPackageVersion(), '100.0.0-amazing.1')
      })

      it('release 100.0.0-amazing.0 with prerelease amazing bumps build', async function () {
        mock({
          bump: 'patch',
          fs: { 'CHANGELOG.md': 'legacy header format<a name="100.0.0-amazing.0">\n' },
          pkg: {
            version: '100.0.0-amazing.1'
          }
        })
        await exec('--release-as 100.0.0-amazing.0 --prerelease amazing')
        should.equal(getPackageVersion(), '100.0.0-amazing.2')
      })

      it('release 100.0.0 with prerelease amazing correctly sets version', async function () {
        mock({
          bump: 'patch',
          fs: { 'CHANGELOG.md': 'legacy header format<a name="100.0.0-amazing.0">\n' },
          pkg: {
            version: '99.0.0-amazing.0'
          }
        })
        await exec('--release-as 100.0.0 --prerelease amazing')
        should.equal(getPackageVersion(), '100.0.0-amazing.0')
      })

      it('release 100.0.0-amazing.0 with prerelease amazing correctly sets version', async function () {
        mock({
          bump: 'patch',
          fs: { 'CHANGELOG.md': 'legacy header format<a name="100.0.0-amazing.0">\n' },
          pkg: {
            version: '99.0.0-amazing.0'
          }
        })
        await exec('--release-as 100.0.0-amazing.0 --prerelease amazing')
        should.equal(getPackageVersion(), '100.0.0-amazing.0')
      })

      it('release 100.0.0-amazing.0 with prerelease amazing retains build metadata', async function () {
        mock({
          bump: 'patch',
          fs: { 'CHANGELOG.md': 'legacy header format<a name="100.0.0-amazing.0">\n' },
          pkg: {
            version: '100.0.0-amazing.0'
          }
        })
        await exec('--release-as 100.0.0-amazing.0+build.1234 --prerelease amazing')
        should.equal(getPackageVersion(), '100.0.0-amazing.1+build.1234')
      })

      it('release 100.0.0-amazing.3 with prerelease amazing correctly sets prerelease version', async function () {
        mock({
          bump: 'patch',
          fs: { 'CHANGELOG.md': 'legacy header format<a name="100.0.0-amazing.0">\n' },
          pkg: {
            version: '100.0.0-amazing.0'
          }
        })
        await exec('--release-as 100.0.0-amazing.3 --prerelease amazing')
        should.equal(getPackageVersion(), '100.0.0-amazing.3')
      })
    })

    it('creates a prerelease with a new minor version after two prerelease patches', async function () {
      let releaseType = 'patch'
      const bump = (_, __, cb) => cb(null, { releaseType })
      mock({
        bump,
        fs: { 'CHANGELOG.md': 'legacy header format<a name="1.0.0">\n' }
      })

      await exec('--release-as patch --prerelease dev')
      getPackageVersion().should.equal('1.0.1-dev.0')

      await exec('--prerelease dev')
      getPackageVersion().should.equal('1.0.1-dev.1')

      releaseType = 'minor'
      await exec('--release-as minor --prerelease dev')
      getPackageVersion().should.equal('1.1.0-dev.0')

      await exec('--release-as minor --prerelease dev')
      getPackageVersion().should.equal('1.1.0-dev.1')

      await exec('--prerelease dev')
      getPackageVersion().should.equal('1.1.0-dev.2')
    })

    it('exits with error if an invalid release version is provided', async function () {
      mock({ bump: 'minor', fs: { 'CHANGELOG.md': '' } })

      expect(exec('--release-as 10.2')).to.be.rejectedWith(/releaseAs must be one of/)
    })

    it('exits with error if release version conflicts with prerelease', async function () {
      mock({ bump: 'minor', fs: { 'CHANGELOG.md': '' } })

      expect(exec('--release-as 1.2.3-amazing.2 --prerelease awesome')).to.be
        .rejectedWith(/releaseAs and prerelease have conflicting prerelease identifiers/)
    })
  })

  it('appends line feed at end of package.json', async function () {
    mock({ bump: 'patch' })
    await exec()
    const pkgJson = fs.readFileSync('package.json', 'utf-8')
    pkgJson.should.equal('{\n  "version": "1.0.1"\n}\n')
  })

  it('preserves indentation of tabs in package.json', async function () {
    mock({
      bump: 'patch',
      fs: { 'package.json': '{\n\t"version": "1.0.0"\n}\n' }
    })
    await exec()
    const pkgJson = fs.readFileSync('package.json', 'utf-8')
    pkgJson.should.equal('{\n\t"version": "1.0.1"\n}\n')
  })

  it('preserves indentation of spaces in package.json', async function () {
    mock({
      bump: 'patch',
      fs: { 'package.json': '{\n    "version": "1.0.0"\n}\n' }
    })
    await exec()
    const pkgJson = fs.readFileSync('package.json', 'utf-8')
    pkgJson.should.equal('{\n    "version": "1.0.1"\n}\n')
  })

  it('preserves carriage return + line feed in package.json', async function () {
    mock({
      bump: 'patch',
      fs: { 'package.json': '{\r\n  "version": "1.0.0"\r\n}\r\n' }
    })
    await exec()
    const pkgJson = fs.readFileSync('package.json', 'utf-8')
    pkgJson.should.equal('{\r\n  "version": "1.0.1"\r\n}\r\n')
  })

  it('does not print output when the --silent flag is passed', async function () {
    const flush = mock()
    await exec('--silent')
    flush().should.eql({ stdout: [], stderr: [] })
  })
})

describe('commit-and-tag-version', function () {
  afterEach(unmock)

  it('should exit on bump error', async function () {
    mock({ bump: new Error('bump err') })

    expect(exec()).to.be.rejectedWith(/bump err/)
  })

  it('should exit on changelog error', async function () {
    mock({ bump: 'minor', changelog: new Error('changelog err') })

    expect(exec()).to.be.rejectedWith(/changelog err/)
  })

  it('should exit with error without a package file to bump', async function () {
    mock({ bump: 'patch', pkg: false })

    expect(exec({ gitTagFallback: false })).to.be.rejectedWith('no package file found')
  })

  it('bumps version # in bower.json', async function () {
    mock({
      bump: 'minor',
      fs: { 'bower.json': JSON.stringify({ version: '1.0.0' }) },
      tags: ['v1.0.0']
    })
    await exec()
    JSON.parse(fs.readFileSync('bower.json', 'utf-8')).version.should.equal(
      '1.1.0'
    )
    getPackageVersion().should.equal('1.1.0')
  })

  it('bumps version # in manifest.json', async function () {
    mock({
      bump: 'minor',
      fs: { 'manifest.json': JSON.stringify({ version: '1.0.0' }) },
      tags: ['v1.0.0']
    })
    await exec()
    JSON.parse(fs.readFileSync('manifest.json', 'utf-8')).version.should.equal(
      '1.1.0'
    )
    getPackageVersion().should.equal('1.1.0')
  })

  describe('custom `bumpFiles` support', function () {
    it('mix.exs + version.txt', async function () {
      const updater = 'custom-updater.js'
      const updaterModule = require('./mocks/updater/customer-updater')
      mock({
        bump: 'minor',
        fs: {
          'mix.exs': fs.readFileSync('./test/mocks/mix.exs'),
          'version.txt': fs.readFileSync('./test/mocks/version.txt')
        },
        tags: ['v1.0.0']
      })
      mockery.registerMock(resolve(process.cwd(), updater), updaterModule)

      await exec({
        bumpFiles: [
          'version.txt',
          { filename: 'mix.exs', updater: 'custom-updater.js' }
        ]
      })
      fs.readFileSync('mix.exs', 'utf-8').should.contain('version: "1.1.0"')
      fs.readFileSync('version.txt', 'utf-8').should.equal('1.1.0')
    })

    it('bumps a custom `plain-text` file', async function () {
      mock({
        bump: 'minor',
        fs: {
          'VERSION_TRACKER.txt': fs.readFileSync(
            './test/mocks/VERSION-1.0.0.txt'
          )
        }
      })
      await exec({
        bumpFiles: [{ filename: 'VERSION_TRACKER.txt', type: 'plain-text' }]
      })
      fs.readFileSync('VERSION_TRACKER.txt', 'utf-8').should.equal('1.1.0')
    })

    it('displays the new version from custom bumper with --dry-run', async function () {
      const updater = 'increment-updater.js'
      const updaterModule = require('./mocks/updater/increment-updater')
      mock({
        bump: 'minor',
        fs: {
          'increment-version.txt': fs.readFileSync(
            './test/mocks/increment-version.txt'
          )
        }
      })
      mockery.registerMock(resolve(process.cwd(), updater), updaterModule)

      const origInfo = console.info
      const capturedOutput = []
      console.info = (...args) => {
        capturedOutput.push(...args)
        origInfo(...args)
      }
      try {
        await exec({
          bumpFiles: [{ filename: 'increment-version.txt', updater: 'increment-updater.js' }],
          dryRun: true
        })
        const logOutput = capturedOutput.join(' ')
        stripAnsi(logOutput).should.include('bumping version in increment-version.txt from 1 to 2')
      } finally {
        console.info = origInfo
      }
    })
  })

  describe('custom `packageFiles` support', function () {
    it('reads and writes to a custom `plain-text` file', async function () {
      mock({
        bump: 'minor',
        fs: {
          'VERSION_TRACKER.txt': fs.readFileSync(
            './test/mocks/VERSION-6.3.1.txt'
          )
        }
      })
      await exec({
        packageFiles: [{ filename: 'VERSION_TRACKER.txt', type: 'plain-text' }],
        bumpFiles: [{ filename: 'VERSION_TRACKER.txt', type: 'plain-text' }]
      })
      fs.readFileSync('VERSION_TRACKER.txt', 'utf-8').should.equal('6.4.0')
    })

    it('allows same object to be used in packageFiles and bumpFiles', async function () {
      mock({
        bump: 'minor',
        fs: {
          'VERSION_TRACKER.txt': fs.readFileSync(
            './test/mocks/VERSION-6.3.1.txt'
          )
        }
      })
      const origWarn = console.warn
      console.warn = () => {
        throw new Error('console.warn should not be called')
      }
      const filedesc = { filename: 'VERSION_TRACKER.txt', type: 'plain-text' }
      try {
        await exec({ packageFiles: [filedesc], bumpFiles: [filedesc] })
        fs.readFileSync('VERSION_TRACKER.txt', 'utf-8').should.equal('6.4.0')
      } finally {
        console.warn = origWarn
      }
    })
  })

  it('`packageFiles` are bumped along with `bumpFiles` defaults [commit-and-tag-version#533]', async function () {
    mock({
      bump: 'minor',
      fs: {
        '.gitignore': '',
        'package-lock.json': JSON.stringify({ version: '1.0.0' }),
        'manifest.json': fs.readFileSync('./test/mocks/manifest-6.3.1.json')
      },
      tags: ['v1.0.0']
    })

    await exec({
      silent: true,
      packageFiles: [
        {
          filename: 'manifest.json',
          type: 'json'
        }
      ]
    })

    JSON.parse(fs.readFileSync('manifest.json', 'utf-8')).version.should.equal(
      '6.4.0'
    )
    JSON.parse(fs.readFileSync('package.json', 'utf-8')).version.should.equal(
      '6.4.0'
    )
    JSON.parse(
      fs.readFileSync('package-lock.json', 'utf-8')
    ).version.should.equal('6.4.0')
  })

  it('bumps version in Gradle `build.gradle.kts` file', async function () {
    const expected = fs.readFileSync('./test/mocks/build-6.4.0.gradle.kts', 'utf-8')
    mock({
      bump: 'minor',
      fs: {
        'build.gradle.kts': fs.readFileSync('./test/mocks/build-6.3.1.gradle.kts')
      }
    })
    await exec({
      packageFiles: [{ filename: 'build.gradle.kts', type: 'gradle' }],
      bumpFiles: [{ filename: 'build.gradle.kts', type: 'gradle' }]
    })
    fs.readFileSync('build.gradle.kts', 'utf-8').should.equal(expected)
  })

  it('bumps version # in npm-shrinkwrap.json', async function () {
    mock({
      bump: 'minor',
      fs: {
        'npm-shrinkwrap.json': JSON.stringify({ version: '1.0.0' })
      },
      tags: ['v1.0.0']
    })
    await exec()
    JSON.parse(
      fs.readFileSync('npm-shrinkwrap.json', 'utf-8')
    ).version.should.equal('1.1.0')
    getPackageVersion().should.equal('1.1.0')
  })

  it('bumps version # in package-lock.json', async function () {
    mock({
      bump: 'minor',
      fs: {
        '.gitignore': '',
        'package-lock.json': JSON.stringify({ version: '1.0.0' })
      },
      tags: ['v1.0.0']
    })
    await exec()
    JSON.parse(
      fs.readFileSync('package-lock.json', 'utf-8')
    ).version.should.equal('1.1.0')
    getPackageVersion().should.equal('1.1.0')
  })

  describe('skip', () => {
    it('allows bump and changelog generation to be skipped', async function () {
      const changelogContent = 'legacy header format<a name="1.0.0">\n'
      mock({
        bump: 'minor',
        changelog: 'foo\n',
        fs: { 'CHANGELOG.md': changelogContent }
      })

      await exec('--skip.bump true --skip.changelog true')
      getPackageVersion().should.equal('1.0.0')
      const content = fs.readFileSync('CHANGELOG.md', 'utf-8')
      content.should.equal(changelogContent)
    })
  })

  it('does not update files present in .gitignore', async () => {
    mock({
      bump: 'minor',
      fs: {
        '.gitignore': 'package-lock.json\nbower.json',
        // test a defaults.packageFiles
        'bower.json': JSON.stringify({ version: '1.0.0' }),
        // test a defaults.bumpFiles
        'package-lock.json': JSON.stringify({
          name: '@org/package',
          version: '1.0.0',
          lockfileVersion: 1
        })
      },
      tags: ['v1.0.0']
    })
    await exec()
    JSON.parse(
      fs.readFileSync('package-lock.json', 'utf-8')
    ).version.should.equal('1.0.0')
    JSON.parse(fs.readFileSync('bower.json', 'utf-8')).version.should.equal(
      '1.0.0'
    )
    getPackageVersion().should.equal('1.1.0')
  })

  describe('configuration', () => {
    it('--header', async function () {
      mock({ bump: 'minor', fs: { 'CHANGELOG.md': '' } })
      await exec('--header="# Welcome to our CHANGELOG.md"')
      const content = fs.readFileSync('CHANGELOG.md', 'utf-8')
      content.should.match(/# Welcome to our CHANGELOG.md/)
    })

    it('--issuePrefixes and --issueUrlFormat', async function () {
      const format = 'http://www.foo.com/{{prefix}}{{id}}'
      const prefix = 'ABC-'
      const changelog = ({ preset }) =>
        preset.issueUrlFormat + ':' + preset.issuePrefixes
      mock({ bump: 'minor', changelog })
      await exec(`--issuePrefixes="${prefix}" --issueUrlFormat="${format}"`)
      const content = fs.readFileSync('CHANGELOG.md', 'utf-8')
      content.should.include(`${format}:${prefix}`)
    })
  })

  describe('pre-major', () => {
    it('bumps the minor rather than major, if version < 1.0.0', async function () {
      mock({
        bump: 'minor',
        pkg: {
          version: '0.5.0',
          repository: { url: 'https://github.com/yargs/yargs.git' }
        }
      })
      await exec()
      getPackageVersion().should.equal('0.6.0')
    })

    it('bumps major if --release-as=major specified, if version < 1.0.0', async function () {
      mock({
        bump: 'major',
        pkg: {
          version: '0.5.0',
          repository: { url: 'https://github.com/yargs/yargs.git' }
        }
      })
      await exec('-r major')
      getPackageVersion().should.equal('1.0.0')
    })
  })
})

describe('GHSL-2020-111', function () {
  afterEach(unmock)

  it('does not allow command injection via basic configuration', async function () {
    mock({ bump: 'patch' })
    await exec({
      noVerify: true,
      infile: 'foo.txt',
      releaseCommitMessageFormat: 'bla `touch exploit`'
    })
    const stat = shell.test('-f', './exploit')
    stat.should.equal(false)
  })
})

describe('with mocked git', function () {
  afterEach(unmock)

  it('--sign signs the commit and tag', async function () {
    const gitArgs = [
      ['add', 'CHANGELOG.md', 'package.json'],
      [
        'commit',
        '-S',
        'CHANGELOG.md',
        'package.json',
        '-m',
        'chore(release): 1.0.1'
      ],
      ['tag', '-s', 'v1.0.1', '-m', 'chore(release): 1.0.1'],
      ['rev-parse', '--abbrev-ref', 'HEAD']
    ]
    const execFile = (_args, cmd, cmdArgs) => {
      cmd.should.equal('git')
      const expected = gitArgs.shift()
      cmdArgs.should.deep.equal(expected)
      if (expected[0] === 'rev-parse') return Promise.resolve('master')
      return Promise.resolve('')
    }
    mock({ bump: 'patch', changelog: 'foo\n', execFile })

    await exec('--sign', true)
    gitArgs.should.have.lengthOf(0)
  })

  it('--tag-force forces tag replacement', async function () {
    const gitArgs = [
      ['add', 'CHANGELOG.md', 'package.json'],
      ['commit', 'CHANGELOG.md', 'package.json', '-m', 'chore(release): 1.0.1'],
      ['tag', '-a', '-f', 'v1.0.1', '-m', 'chore(release): 1.0.1'],
      ['rev-parse', '--abbrev-ref', 'HEAD']
    ]
    const execFile = (_args, cmd, cmdArgs) => {
      cmd.should.equal('git')
      const expected = gitArgs.shift()
      cmdArgs.should.deep.equal(expected)
      if (expected[0] === 'rev-parse') return Promise.resolve('master')
      return Promise.resolve('')
    }
    mock({ bump: 'patch', changelog: 'foo\n', execFile })

    await exec('--tag-force', true)
    gitArgs.should.have.lengthOf(0)
  })

  it('fails if git add fails', async function () {
    const gitArgs = [['add', 'CHANGELOG.md', 'package.json']]
    const gitError = new Error('Command failed: git\nfailed add')
    const execFile = (_args, cmd, cmdArgs) => {
      cmd.should.equal('git')
      const expected = gitArgs.shift()
      cmdArgs.should.deep.equal(expected)

      if (expected[0] === 'add') {
        return Promise.reject(gitError)
      }
      return Promise.resolve('')
    }
    mock({ bump: 'patch', changelog: 'foo\n', execFile })

    expect(exec({}, true)).to.be.rejectedWith(gitError)
  })

  it('fails if git commit fails', async function () {
    const gitArgs = [
      ['add', 'CHANGELOG.md', 'package.json'],
      ['commit', 'CHANGELOG.md', 'package.json', '-m', 'chore(release): 1.0.1']
    ]
    const gitError = new Error('Command failed: git\nfailed commit')
    const execFile = (_args, cmd, cmdArgs) => {
      cmd.should.equal('git')
      const expected = gitArgs.shift()
      cmdArgs.should.deep.equal(expected)
      if (expected[0] === 'commit') {
        return Promise.reject(gitError)
      }
      return Promise.resolve('')
    }
    mock({ bump: 'patch', changelog: 'foo\n', execFile })

    expect(exec({}, true)).to.be.rejectedWith(gitError)
  })

  it('fails if git tag fails', async function () {
    const gitArgs = [
      ['add', 'CHANGELOG.md', 'package.json'],
      ['commit', 'CHANGELOG.md', 'package.json', '-m', 'chore(release): 1.0.1'],
      ['tag', '-a', 'v1.0.1', '-m', 'chore(release): 1.0.1']
    ]
    const gitError = new Error('Command failed: git\nfailed tag')
    const execFile = (_args, cmd, cmdArgs) => {
      cmd.should.equal('git')
      const expected = gitArgs.shift()
      cmdArgs.should.deep.equal(expected)
      if (expected[0] === 'tag') {
        return Promise.reject(gitError)
      }
      return Promise.resolve('')
    }
    mock({ bump: 'patch', changelog: 'foo\n', execFile })

    expect(exec({}, true)).to.be.rejectedWith(gitError)
  })
})
