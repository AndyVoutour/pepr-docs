import { program } from 'commander';
import * as path from 'node:path';
import * as process from 'node:process';
import * as fs from 'node:fs/promises';
import * as util from 'node:util'
import * as child_process from 'node:child_process';
import * as semver from 'semver';
import * as yaml from 'yaml';
import { heredoc } from './heredoc.mjs';

const exec = util.promisify(child_process.exec);

program
  .version('0.0.0', '-v, --version')
  .requiredOption('-c, --core <path>', 'path to core project folder')
  .requiredOption('-s, --site <path>', 'path to docs site folder')
  .parse(process.argv);
const opts = program.opts();

const RUN = { cutoff: 3 } // global state bucket!

async function activity(label, func) {
  let log = []
  let err = ""
  
  try {
    console.time(label)
    await func(log)

  } catch (e) {
    err = e

  } finally {
    console.timeEnd(label)
    log.forEach(([key, val]) => { console.log(" ", key.padEnd(10), ":", val) })

    if (err) {
      ['', err, '', 'State dump:', RUN].forEach(m => console.error(m))
      program.error("")
    }

    console.log()
  }
}

function majmin(version) {
  return `${semver.major(version)}.${semver.minor(version)}`
}

function rewriteRemoteVideoLinks(content) {
  // rewrite raw githubusercontent video links into video tags
  return content.replaceAll(
    /https[\S]*.mp4/g,
    (url) => `<video class="td-content" controls src="${url}"></video>`
  )
}

const TOTAL = 'Total build time'
console.time(TOTAL)

await activity(`Validate args`, async (log) => {
  const dirOrDie = async (path) => {
    if ( !(await fs.stat(path)).isDirectory() ) {
      throw new Error(`Not a directory: '${path}'`)
    }
  }

  RUN.site = path.resolve(opts.site)
  await dirOrDie(RUN.site)

  RUN.core = path.resolve(opts.core)
  await dirOrDie(RUN.core)

  log.push(['site', RUN.site])
  log.push(['core', RUN.core])
})

RUN.work = path.resolve('./work')

await activity(`Clean work dir`, async (log) => {
  await fs.rm(RUN.work, {recursive: true, force: true})
  await fs.mkdir(RUN.work)

  log.push(['work', RUN.work])
})

await activity(`Copy site src to work dir`, async () => {
  await fs.cp(RUN.site, RUN.work, {recursive: true})
})

await activity(`Search core repo versions`, async (log) => {
  let { stdout } = await exec(`
    cd ${RUN.core}
    git tag
  `);
  const tags = stdout.trim().split("\n")
  const vers = tags.filter(semver.valid)
  const sort = semver.rsort(vers)

  const majmins = sort.map(v => majmin(v))
    .reduce((list, mm) => {
      list.includes(mm) ? null : list.push(mm)
      return list
    }, [])

  const ongoing = majmins.slice(0, RUN.cutoff)
  const retired = majmins.slice(RUN.cutoff)

  RUN.versions = sort.reduce((list, ver) => {
    const mm = majmin(ver)
    ongoing.includes(mm) ? list.push(ver) : null
    return list
  }, [])
  RUN.versions.push("main")

  log.push(['ongoing', ongoing])
  log.push(['retired', retired])
  log.push(['versions', RUN.versions])
})


for (const version of RUN.versions) {
  RUN.version = version
  RUN.verdir = `${RUN.work}/content/en/${RUN.version}`
  RUN.found = false
  RUN.coredocs = `${RUN.core}/docs`

  await activity(`Build ${RUN.version}`, async (log) => {
    let dirExists = async (path) => {
      try {
        if ( !(await fs.stat(path)).isDirectory() ) { return false }
      } catch { return false }

      return true
    }

    RUN.found = await dirExists(RUN.verdir)

    // always rebuild main
    if (RUN.found && RUN.version  === 'main') {
      await fs.rm(RUN.verdir, {recursive: true, force: true})
      RUN.found = false
    }

    log.push(['skip', RUN.found])
  })

  if (RUN.found) { continue }

  await activity(`Create version dir`, async (log) => {
    await fs.mkdir(RUN.verdir)
    log.push(['dir', RUN.verdir])
  })

  await activity(`Checkout core version`, async (log) => {
    await exec(`
      cd ${RUN.core}
      git checkout ${RUN.version}
    `);

    let result = RUN.version === 'main'
      ? await exec(`cd ${RUN.core} ; git branch --show-current`)
      : await exec(`cd ${RUN.core} ; git describe --tags`)

    result = result.stdout.trim()

    log.push(['repo', RUN.core])
    RUN.version === 'main'
      ? log.push(['branch', result])
      : log.push(['tag', result])
  })

  await activity(`Find source doc files`, async (log) => {
    let sources = await fs.readdir(RUN.coredocs, { recursive: true })

    // TBD: impl sub-dir-to-site-menu structures once docs have content needing it
    // let subdirs = ""

    // process only .mds
    RUN.srcmds = sources.filter(f => f.endsWith('.md'))

    // ...but not non-root README.md (they're just sub-menus for GH UI)
    RUN.srcmds = RUN.srcmds.filter(f => !f.endsWith('README.md'))

    const srcign = sources.filter(s => !RUN.srcmds.includes(s))

    log.push(['sources', RUN.srcmds])
    log.push(['ignored', srcign])
  })

  await activity(`Copy repo images`, async (log) => {
    const srcimgs = `${RUN.core}/.images`
    const dstimgs = `${RUN.work}/static/${RUN.version}/.images`
    await fs.cp(srcimgs, dstimgs, {recursive: true})
    
    log.push(['src', srcimgs])
    log.push(['dst', dstimgs])
  })


  for (const srcmd of RUN.srcmds) {
    RUN.srcmd = { file: srcmd, content: "" }
    
    await activity(`Read source file`, async (log) => {
      const src = `${RUN.coredocs}/${RUN.srcmd.file}`
      RUN.srcmd.content = await fs.readFile(src, { encoding: 'utf8' })
      log.push(['src', src])
    })

    await activity(`Inject Hugo front matter`, async () => {
      // // title as filename sans extension
      // const title = path.basename(RUN.srcmd.file, '.md')

      // // title as filename with extension
      // const title = path.basename(RUN.srcmd.file)

      // title as sanitized content from first heading
      const heading = RUN.srcmd.content.match(/#[\s]+(.*)/)
      const title = heading[1]
        .replaceAll("`", "")
        .replaceAll(":", "")
      RUN.srcmd.content = RUN.srcmd.content.replaceAll(heading[0], '')

      const front = heredoc`
        ---
        title: ${title}
        ---
      `
      RUN.srcmd.content = [front, RUN.srcmd.content].join("\n")
    })

    await activity(`Rewrite broken content`, async () => {
      RUN.srcmd.content = rewriteRemoteVideoLinks(RUN.srcmd.content)

      // rewrite relative .md link paths to compensate Hugo-gen'd pretty path
      RUN.srcmd.content = RUN.srcmd.content.replaceAll('](./', '](../')

      // rewrite .md link paths to match Hugo's pretty link format
      RUN.srcmd.content = RUN.srcmd.content.replaceAll('.md)', '/)')

      // rewrite anchored .md link paths to match Hugo's pretty link format
      RUN.srcmd.content = RUN.srcmd.content.replaceAll(
        /.md#(.*)\)/g,
        (_, group) => `#${group})`
      )
    })

    await activity(`Write result file`, async (log) => {
      const dst = `${RUN.verdir}/${RUN.srcmd.file}`
      await fs.writeFile(dst, RUN.srcmd.content, { encoding: 'utf8' })
      log.push(['dst', dst])
    })

  }

  await activity(`Write version layout & landing content`, async (log) => {
    const idxMd = `${RUN.verdir}/_index.md`
    const idxFront = heredoc`
      ---
      title: ${RUN.version}
      cascade:
        type: docs
      aliases: []
      ---
    `
    const rootMd = `${RUN.core}/README.md`
    let idxBody = await fs.readFile(rootMd, { encoding: 'utf8' })

    // trim 'docs' out of link paths
    idxBody = idxBody.replaceAll('](./docs/', '](./')

    // rewrite .md link paths to match Hugo's pretty link format
    idxBody = idxBody.replaceAll('.md)', '/)')

    // rewrite raw githubusercontent video links into video tags
    idxBody = rewriteRemoteVideoLinks(idxBody)

    const idxContent = [idxFront, idxBody].join("\n")
    await fs.writeFile(idxMd, idxContent, { encoding: 'utf8' })

    log.push(['dst', idxMd]) 
  })

}

await activity(`Update version dropdown options`, async (log) => {
  const hugoFile = `${RUN.work}/hugo.yaml`
  const hugoYaml = await fs.readFile(hugoFile, { encoding: 'utf8' })
  const hugoConf = yaml.parse(hugoYaml)

  const uniques = {}
  RUN.versions.filter(v => v !== 'main').forEach(version => {
    const mm = majmin(version)
    if (!uniques.hasOwnProperty(mm)) { uniques[mm] = version }
  })

  const opts = Object.entries(uniques).map(([majmin, version]) => ({
    version: `v${majmin}`,
    url: `/${version}/`
  }))
  opts.push({ version: 'main', url: '/main/' })

  hugoConf.params.versions = opts
  await fs.writeFile(hugoFile, yaml.stringify(hugoConf), { encoding: 'utf8' })

  log.push(['opts', opts.map(o => o.version)])
})

await activity(`Clear '/current' version alias`, async () => {
  for (const version of RUN.versions) {
    const idxPath = `${RUN.work}/content/en/${version}/_index.md`
    let content = await fs.readFile(idxPath, { encoding: 'utf8' })

    content = content.replace(/aliases: \[.*\]/,"aliases: []")

    await fs.writeFile(idxPath, content, { encoding: 'utf8' })
  }
})

await activity(`Set '/current' version alias`, async (log) => {
  const current = RUN.versions[0]
  const verPath = `${RUN.work}/content/en/${current}/_index.md`
  let content = await fs.readFile(verPath, { encoding: 'utf8' })

  content = content.replace(/aliases: \[\]/,"aliases: [\"/current/\"]")

  await fs.writeFile(verPath, content, { encoding: 'utf8' })

  log.push(['current', current])
})

await activity(`Clean dist dir`, async (log) => {
  RUN.dist = path.resolve(`${RUN.site}/../dist`)
  await fs.rm(RUN.dist, {recursive: true, force: true})
  await fs.mkdir(RUN.dist)

  log.push(['dist', RUN.dist])
})

await activity(`Build site into dist dir`, async () => {
  await exec(`
    cd ${RUN.work}
    npm ci
    npm run build:production -- --destination ${RUN.dist}
  `);
})

console.timeEnd(TOTAL)
console.log("")