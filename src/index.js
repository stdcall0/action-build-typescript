const core = require("@actions/core");
const github = require("@actions/github");
const io = require("@actions/io");
const fs = require("fs");
const { exec } = require("@actions/exec");
const { access } = require("fs").promises;
const { join } = require("path");

// Inputs
const pushToBranch = core.getInput("pushToBranch");
const branchName = core.getInput("branch");
const githubToken = core.getInput("githubToken");
const directory = process.env.GITHUB_WORKSPACE;

if (pushToBranch == true && !githubToken)
  return exit(
    "A GitHub secret token is a required input for pushing code (hint: use ${{ secrets.GITHUB_TOKEN }} )"
  );

(async () => {
  const tsconfigPath = join(directory, "tsconfig.json");

  try {
    await access(tsconfigPath);

    const tsconfig = require(tsconfigPath);
    const outDir = tsconfig.compilerOptions.outDir
      ? tsconfig.compilerOptions.outDir
      : directory;
    // Install tsc
    core.info("Installing tsc");
    await exec("npm i --g typescript");

    core.info("Installing dependencies");
    await exec(`npm i`, [], { cwd: directory }).catch((_err) => {});

    // Build project
    console.info("Building project");
    const build = await exec(`tsc`, [], { cwd: directory });
    if (build !== 0) return exit("Something went wrong while building.");
    if (pushToBranch == "false") return process.exit(0);


    const octokit = github.getOctokit(githubToken);

    const [owner, repo] = process.env.GITHUB_REPOSITORY.split("/");
    const branches = await octokit.repos.listBranches({
      owner,
      repo,
    });

    const branchExists = branches.data.some(
      (branch) => branch.name.toLowerCase() === branchName
    );
    const branchDir = join(process.env.GITHUB_WORKSPACE, `../branch-${branchName}`);
    // Set up Git user
    core.info("Configuring Git user");
    await exec(`git config --global user.name actions-user`);
    await exec(`git config --global user.email action@github.com`);
    
    core.info("Cloning branch");
    const clone = await exec(
      `git clone https://${github.context.actor}:${githubToken}@github.com/${owner}/${repo}.git ${branchDir}`
    );
    if (clone !== 0)
      return exit("Something went wrong while cloning the repository.");
    // Check out to branch
    await exec(
      `${
        branchExists
          ? `git checkout ${branchName}`
          : `git checkout --orphan ${branchName}`
      }`,
      [],
      { cwd: branchDir }
    );
    
    /* await exec(
      `git switch -c ${branchName} master`,
      [],
      { cwd: directory }
    ); */

    core.info(`Directory: ${directory}`);
    core.info(`${branchDir}`);
    
    core.info("Removing original files");
    let t = fs.readdirSync(branchDir, {withFileTypes: true})
      .filter(item => item.name != ".git")
      .map(item => item.name)
    for (let i = 0; i < t.length; ++i) await io.rmRF(join(branchDir, t[i]));

    core.info("Copying new files");
    t = fs.readdirSync(directory, {withFileTypes: true})
      .filter(item => item.name != ".git")
      .map(item => item.name);
    for (let i = 0; i < t.length; ++i) await io.cp(join(directory, t[i]), branchDir, { recursive: true, force: true });
    
    // Commit files
    core.info("Adding and commiting files");
    await exec(`git add -A"`, [], { cwd: branchDir });
    
    core.info("Removing typescript files");
    await exec(
      `git rm -r -f *.ts`,
      [],
      { cwd: branchDir }
    );
    
    
    // We use the catch here because sometimes the code itself may not have changed
    await exec(`git commit -m "TS Build: ${github.context.sha} ${{ github.event.workflow_run.head_commit.message }}"`, [], {
      cwd: branchDir,
    }).catch((_err) =>
      core.warning("Couldn't commit new changes because there aren't any")
    );

    // Push files
    core.info("Pushing new changes");
    await exec(`git push --force origin HEAD:${branchName}`, [], {
      cwd: branchDir,
    });

    process.exit(0);
  } catch (error) {
    exit(`Something went wrong: ${error}`);
  }
})();

function exit(error) {
  core.setFailed(error);
  process.exit();
}
