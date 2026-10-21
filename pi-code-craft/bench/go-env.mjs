// The benchmark's Go toolchains and caches, kept under the corpus directory so
// nothing is installed system-wide. etcd's dependencies at the benchmark's
// commits do not build with Go 1.27 (its HTTP/2 package changed), so etcd
// cases use Go 1.26, the release those changes targeted.
import { join } from "node:path";
import { DATA_DIR } from "../mining/config.mjs";

export const BENCH = join(DATA_DIR, "bench");
const GOROOTS = { default: join(BENCH, "go"), "go1.26": join(BENCH, "go1.26") };
export const goRootFor = id => (/^etcd-/.test(id ?? "") ? GOROOTS["go1.26"] : GOROOTS.default);
export const goEnv = (id, extra = {}) => ({
  ...process.env,
  PATH: `${join(goRootFor(id), "bin")}:${process.env.PATH}`,
  GOROOT: goRootFor(id),
  GOPATH: join(BENCH, "gopath"),
  GOCACHE: join(BENCH, "gocache"),
  GOTOOLCHAIN: "local",
  // Builds of etcd, gRPC and Prometheus test binaries take gigabytes each; at
  // the default parallelism several trials at once exhaust memory.
  GOFLAGS: "-p=4",
  GOMAXPROCS: "6",
  ...extra,
});
