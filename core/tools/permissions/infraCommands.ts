/**
 * Infrastructure commands that remove or tear down what runs somewhere else
 * (ROADMAP B59), read by `ask-destructive-commands` with the same candidate
 * strings and wrapper skipping as the git and `rm` checks. Each returns the
 * text it asks with, or undefined. They over-match on purpose: a `delete`
 * word among the leading operands asks.
 *
 *   kubectl delete      kubectl drain        helm uninstall
 *   terraform destroy   terraform apply -auto-approve
 *   pulumi destroy      aws ec2 terminate-instances   aws s3 rm --recursive
 *   az group delete     gcloud compute instances delete
 *   docker rm -f        docker volume rm     docker compose down -v
 */

const KUBECTL_VALUE_FLAGS = new Set([
  "-n",
  "--namespace",
  "-s",
  "--server",
  "--context",
  "--cluster",
  "--user",
  "--kubeconfig",
  "--as",
  "--token",
]);

const AWS_VALUE_FLAGS = new Set([
  "--profile",
  "--region",
  "--output",
  "--endpoint-url",
  "--cli-input-json",
  "--query",
]);

const longFlag = (word: string, name: string) =>
  word === `--${name}` || word.startsWith(`--${name}=`);

const hasFlag = (args: string[], short: string, long: string) =>
  args.some(
    (w) =>
      longFlag(w, long) ||
      (/^-[A-Za-z]+$/.test(w) && w.slice(1).includes(short)),
  );

/** The words that are not flags, skipping the value of the flags named. */
function operandsOf(args: string[], valueFlags: Set<string>): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (valueFlags.has(args[i])) i++;
    else if (!args[i].startsWith("-")) out.push(args[i]);
  }
  return out;
}

function kubectlHit(program: string, args: string[]): string | undefined {
  const sub = operandsOf(args, KUBECTL_VALUE_FLAGS)[0]?.toLowerCase();
  if (sub === "delete" || sub === "drain" || sub === "cordon") {
    return `${program} ${sub}`;
  }
  return sub === "replace" && hasFlag(args, "\0", "force")
    ? `${program} replace --force`
    : undefined;
}

function helmHit(args: string[]): string | undefined {
  const sub = operandsOf(
    args,
    new Set(["-n", "--namespace"]),
  )[0]?.toLowerCase();
  return sub === "uninstall" || sub === "delete" || sub === "un"
    ? `helm ${sub}`
    : undefined;
}

function terraformHit(program: string, args: string[]): string | undefined {
  const words = args.map((w) => w.toLowerCase());
  if (words.includes("destroy") || words.includes("-destroy")) {
    return `${program} destroy`;
  }
  const auto = words.some((w) => /^--?auto-approve(=.*)?$/.test(w));
  return auto && words.includes("apply")
    ? `${program} apply -auto-approve`
    : undefined;
}

function awsHit(args: string[]): string | undefined {
  const ops = operandsOf(args, AWS_VALUE_FLAGS).map((w) => w.toLowerCase());
  const op = ops[1] ?? "";
  if (/^(delete|terminate)-/.test(op)) return `aws ${ops[0]} ${op}`;
  if (ops[0] !== "s3") return undefined;
  if (op === "rb") return "aws s3 rb";
  if (op === "rm" && args.some((w) => longFlag(w, "recursive"))) {
    return "aws s3 rm --recursive";
  }
  return op === "sync" && args.some((w) => longFlag(w, "delete"))
    ? "aws s3 sync --delete"
    : undefined;
}

/** `az group delete`, `gcloud compute instances delete`: a delete word among the first operands. */
function cloudDeleteHit(program: string, args: string[]): string | undefined {
  const ops = operandsOf(args, new Set()).slice(0, 5);
  const word = ops.find((w) => /^delete(-|$)/i.test(w));
  return word ? `${program} ${word.toLowerCase()}` : undefined;
}

function dockerHit(program: string, args: string[]): string | undefined {
  const ops = operandsOf(args, new Set(["--context", "-H", "--host"])).map(
    (w) => w.toLowerCase(),
  );
  const [a, b] = ops;
  const force = hasFlag(args, "f", "force");
  if (a === "volume" && (b === "rm" || b === "remove")) {
    return `${program} volume rm`;
  }
  if (force && (a === "rm" || a === "rmi")) return `${program} ${a} -f`;
  if (force && b && ["rm", "rmi", "remove"].includes(b)) {
    return `${program} ${a} ${b} -f`;
  }
  const down =
    program === "docker-compose" ? a === "down" : ops.includes("down");
  const composed = program === "docker-compose" || a === "compose";
  return composed && down && hasFlag(args, "v", "volumes")
    ? `${program} compose down -v`
    : undefined;
}

/** What makes an infrastructure command destructive, or undefined. */
export function infraCommandHit(
  program: string,
  args: string[],
): string | undefined {
  switch (program) {
    case "kubectl":
    case "oc":
      return kubectlHit(program, args);
    case "helm":
      return helmHit(args);
    case "terraform":
    case "tofu":
    case "terragrunt":
      return terraformHit(program, args);
    case "pulumi":
      return operandsOf(args, new Set())[0]?.toLowerCase() === "destroy"
        ? "pulumi destroy"
        : undefined;
    case "aws":
      return awsHit(args);
    case "az":
    case "gcloud":
      return cloudDeleteHit(program, args);
    case "docker":
    case "podman":
    case "docker-compose":
      return dockerHit(program, args);
    default:
      return undefined;
  }
}
