"use strict";

const { TreeBuilder } = require("src/test-reader/tree-builder");
const { InstructionsList } = require("src/test-reader/build-instructions");
const { SkipController } = require("src/test-reader/controllers/skip-controller");
const { OnlyController } = require("src/test-reader/controllers/only-controller");
const { ConfigController } = require("src/test-reader/controllers/config-controller");
const browserVersionController = require("src/test-reader/controllers/browser-version-controller");
const TestParserAPI = require("src/test-reader/test-parser-api");
const { NEW_BUILD_INSTRUCTION } = require("src/test-reader/read-events");
const { Test, Suite } = require("src/test-reader/test-object");
const RunnerEvents = require("src/constants/runner-events");
const { makeConfigStub } = require("../../utils");
const proxyquire = require("proxyquire").noCallThru();
const path = require("path");
const { EventEmitter } = require("events");
const _ = require("lodash");

describe("test-reader/browser-test-parser", () => {
    const sandbox = sinon.sandbox.create();

    let BrowserTestParser;
    let clearRequire;
    let readFiles;

    beforeEach(() => {
        clearRequire = sandbox.stub().named("clear-require");
        readFiles = sandbox.stub().named("readFiles").resolves();

        BrowserTestParser = proxyquire("src/test-reader/browser-test-parser", {
            "clear-require": clearRequire,
            "./mocha-reader": { readFiles },
        }).BrowserTestParser;

        sandbox.stub(InstructionsList.prototype, "push");
        sandbox.stub(InstructionsList.prototype, "unshift");
        sandbox.stub(InstructionsList.prototype, "exec").returns(new Suite());
    });

    afterEach(() => {
        sandbox.restore();

        delete global.hermione;
    });

    describe("addRootSuiteDecorator", () => {
        it("should prepend build instruction", () => {
            const parser = BrowserTestParser.create();

            parser.addRootSuiteDecorator(() => {});

            assert.calledOnceWith(InstructionsList.prototype.unshift, sinon.match.func);
        });

        it("should set passed decorator as trap to tree builder", () => {
            const parser = BrowserTestParser.create();
            const decorator = sinon.spy();
            parser.addRootSuiteDecorator(decorator);

            const buildInstruction = InstructionsList.prototype.unshift.lastCall.args[0];
            const treeBuilder = sinon.createStubInstance(TreeBuilder);

            buildInstruction({ treeBuilder });

            assert.calledWith(treeBuilder.addTrap, decorator);
        });
    });

    describe("applyGrep", () => {
        beforeEach(() => {
            sandbox.stub(TreeBuilder.prototype, "addTestFilter").returnsThis();

            InstructionsList.prototype.push.callsFake(fn => {
                fn({ treeBuilder: new TreeBuilder() });
            });
        });

        it("should add filter to tree builder", () => {
            const parser = BrowserTestParser.create();

            parser.applyGrep(/fooBar/);

            assert.calledOnceWith(TreeBuilder.prototype.addTestFilter, sinon.match.func);
        });

        it("filter should accept matched runnable", () => {
            const parser = BrowserTestParser.create();
            parser.applyGrep(/fooBar/);

            const filter = TreeBuilder.prototype.addTestFilter.lastCall.args[0];
            const suite = { fullTitle: () => "baz fooBar qux" };

            assert.isTrue(filter(suite));
        });

        it("filter should ignore not matched runnable", () => {
            const parser = BrowserTestParser.create();
            parser.applyGrep(/fooBar/);

            const filter = TreeBuilder.prototype.addTestFilter.lastCall.args[0];
            const suite = { fullTitle: () => "baz qux" };

            assert.isFalse(filter(suite));
        });
    });

    describe("loadFiles", () => {
        const loadFiles_ = async ({ parser, files, config, browserId } = {}) => {
            parser = parser || BrowserTestParser.create();
            config = config || makeConfigStub();

            return parser.loadFiles(files || [], config, browserId);
        };

        it("should be chainable", async () => {
            const testParser = BrowserTestParser.create();

            assert.deepEqual(await testParser.loadFiles([], makeConfigStub()), testParser);
        });

        describe("globals", () => {
            it("should create global hermione object", async () => {
                await loadFiles_();

                assert.property(global, "hermione");
            });

            describe("hermione.ctx", () => {
                it("should set hermione.ctx", async () => {
                    const config = makeConfigStub({
                        system: {
                            ctx: { foo: "bar" },
                        },
                    });

                    await loadFiles_({ config });

                    assert.deepEqual(global.hermione.ctx, { foo: "bar" });
                });

                it("should set hermione.ctx before loading files", async () => {
                    const config = makeConfigStub({
                        system: {
                            ctx: { foo: "bar" },
                        },
                    });

                    let ctx;
                    readFiles.callsFake(() => (ctx = global.hermione.ctx));

                    await loadFiles_({ config });

                    assert.deepEqual(ctx, { foo: "bar" });
                });
            });

            describe("hermione.browser", () => {
                beforeEach(() => {
                    sandbox.stub(browserVersionController, "mkProvider").returns(() => {});
                });

                it("should set controller provider", async () => {
                    const provider = () => {};
                    browserVersionController.mkProvider.returns(provider);

                    await loadFiles_();

                    assert.equal(global.hermione.browser, provider);
                });

                it("should set controller provider before loading files", async () => {
                    await loadFiles_();

                    assert.callOrder(browserVersionController.mkProvider, readFiles);
                });

                it("should create controller provider with list of known browsers", async () => {
                    const config = makeConfigStub({ browsers: ["foo", "bar"] });

                    await loadFiles_({ config });

                    assert.calledWith(browserVersionController.mkProvider, ["foo", "bar"]);
                });

                it("should create controller with event bus", async () => {
                    await loadFiles_();

                    assert.calledWith(
                        browserVersionController.mkProvider,
                        sinon.match.any,
                        sinon.match.instanceOf(EventEmitter),
                    );
                });
            });

            Object.entries({
                skip: SkipController,
                only: OnlyController,
            }).forEach(([controllerName, controllerClass]) => {
                describe(`hermions.${controllerName}`, () => {
                    beforeEach(() => {
                        sandbox.spy(controllerClass, "create");
                    });

                    it(`should set hermione.${controllerName}`, async () => {
                        await loadFiles_();

                        assert.instanceOf(global.hermione[controllerName], controllerClass);
                    });

                    it(`should set hermione.${controllerName} before loading files`, async () => {
                        await loadFiles_();

                        assert.callOrder(controllerClass.create, readFiles);
                    });

                    it("should create controller with event bus", async () => {
                        await loadFiles_();

                        assert.calledWith(controllerClass.create, sinon.match.instanceOf(EventEmitter));
                    });
                });
            });

            describe("hermione.config", () => {
                beforeEach(() => {
                    sandbox.stub(ConfigController, "create").returns(Object.create(ConfigController.prototype));
                });

                it("should set hermione.config", async () => {
                    await loadFiles_();

                    assert.instanceOf(global.hermione.config, ConfigController);
                });

                it("should set hermione.config before loading files", async () => {
                    await loadFiles_();

                    assert.callOrder(ConfigController.create, readFiles);
                });

                it("should create controller with event bus", async () => {
                    await loadFiles_();

                    assert.calledWith(ConfigController.create, sinon.match.instanceOf(EventEmitter));
                });
            });
        });

        describe("events", () => {
            describe("on NEW_BUILD_INSTRUCTION", () => {
                it("from reader should push build instruction", async () => {
                    const instruction = sinon.spy();
                    readFiles.callsFake((files, { eventBus }) => {
                        eventBus.emit(NEW_BUILD_INSTRUCTION, instruction);
                    });

                    await loadFiles_();

                    assert.calledWith(InstructionsList.prototype.push, instruction);
                });

                it("from browser version controller should push build instruction", async () => {
                    const instruction = sinon.spy();
                    sandbox.spy(browserVersionController, "mkProvider");
                    readFiles.callsFake(() => {
                        const eventBus = browserVersionController.mkProvider.lastCall.args[1];
                        eventBus.emit(NEW_BUILD_INSTRUCTION, instruction);
                    });

                    await loadFiles_();

                    assert.calledWith(InstructionsList.prototype.push, instruction);
                });

                it("from config controller should push build instruction", async () => {
                    const instruction = sinon.spy();
                    sandbox.spy(ConfigController, "create");
                    readFiles.callsFake(() => {
                        const eventBus = ConfigController.create.lastCall.args[0];
                        eventBus.emit(NEW_BUILD_INSTRUCTION, instruction);
                    });

                    await loadFiles_();

                    assert.calledWith(InstructionsList.prototype.push, instruction);
                });

                it("from skip controller should push build instruction", async () => {
                    const instruction = sinon.spy();
                    sandbox.spy(SkipController, "create");
                    readFiles.callsFake(() => {
                        const eventBus = SkipController.create.lastCall.args[0];
                        eventBus.emit(NEW_BUILD_INSTRUCTION, instruction);
                    });

                    await loadFiles_();

                    assert.calledWith(InstructionsList.prototype.push, instruction);
                });

                it("from only controller should push build instruction", async () => {
                    const instruction = sinon.spy();
                    sandbox.spy(OnlyController, "create");
                    readFiles.callsFake(() => {
                        const eventBus = OnlyController.create.lastCall.args[0];
                        eventBus.emit(NEW_BUILD_INSTRUCTION, instruction);
                    });

                    await loadFiles_();

                    assert.calledWith(InstructionsList.prototype.push, instruction);
                });

                it("from test parser api should push build instruction", async () => {
                    const instruction = sinon.spy();
                    sandbox.spy(TestParserAPI, "create");
                    readFiles.callsFake(() => {
                        const eventBus = TestParserAPI.create.lastCall.args[1];
                        eventBus.emit(NEW_BUILD_INSTRUCTION, instruction);
                    });

                    await loadFiles_();

                    assert.calledWith(InstructionsList.prototype.push, instruction);
                });
            });

            ["BEFORE_FILE_READ", "AFTER_FILE_READ"].forEach(eventName => {
                describe(`on ${eventName}`, () => {
                    beforeEach(() => {
                        sandbox.spy(TestParserAPI, "create");
                    });

                    const init_ = ({ eventData } = {}) => {
                        const onEvent = sinon.stub().named(`on${eventName}`);

                        const parser = BrowserTestParser.create().on(RunnerEvents[eventName], onEvent);

                        readFiles.callsFake((files, { eventBus }) => {
                            eventBus.emit(RunnerEvents[eventName], eventData || { some: "default-data" });
                        });

                        return {
                            onEvent,
                            parser,
                            loadFiles: () => loadFiles_({ parser }),
                        };
                    };

                    it(`should passthrough ${eventName} event`, async () => {
                        const eventData = { file: "foo/bar.js" };
                        const { onEvent, loadFiles } = init_({ eventData });

                        await loadFiles();

                        assert.calledOnceWith(onEvent, sinon.match(eventData));
                    });

                    it(`should extend ${eventName} event data with hermione object`, async () => {
                        const { onEvent, loadFiles } = init_();

                        await loadFiles();

                        assert.calledOnceWith(
                            onEvent,
                            sinon.match({
                                hermione: global.hermione,
                            }),
                        );
                    });

                    if (eventName === "BEFORE_FILE_READ") {
                        it("should create test parser API object", async () => {
                            await loadFiles_();

                            assert.calledOnceWith(
                                TestParserAPI.create,
                                global.hermione,
                                sinon.match.instanceOf(EventEmitter),
                            );
                        });

                        it(`should extend ${eventName} event with test parser API`, async () => {
                            const { onEvent, loadFiles } = init_();

                            await loadFiles();

                            assert.calledOnceWith(
                                onEvent,
                                sinon.match({
                                    testParser: sinon.match.instanceOf(TestParserAPI),
                                }),
                            );
                        });
                    }
                });
            });
        });

        describe("file cache", () => {
            it("should pass files to mocha reader as is", async () => {
                await loadFiles_({ files: ["foo/bar.js", "baz/qux.mjs"] });

                assert.calledWith(readFiles, ["foo/bar.js", "baz/qux.mjs"]);
            });

            it("should clear require cache for commonjs file before reading", async () => {
                await loadFiles_({ files: ["foo/bar.js"] });

                assert.calledOnceWith(clearRequire, path.resolve("foo/bar.js"));
                assert.callOrder(clearRequire, readFiles);
            });

            it("should not clear require cache for ESM files", async () => {
                await loadFiles_({ files: ["foo/bar.mjs"] });

                assert.notCalled(clearRequire);
            });
        });

        describe("read files", () => {
            it("should read passed files", async () => {
                const files = ["foo/bar", "baz/qux"];

                await loadFiles_({ files });

                assert.calledOnceWith(readFiles, files);
            });

            it("should pass mocha opts to reader", async () => {
                const config = makeConfigStub({
                    system: {
                        mochaOpts: {
                            foo: "bar",
                        },
                    },
                });

                await loadFiles_({ config });

                assert.calledWithMatch(readFiles, sinon.match.any, { config: { foo: "bar" } });
            });

            it("should pass event bus to reader", async () => {
                await loadFiles_();

                assert.calledWithMatch(readFiles, sinon.match.any, { eventBus: sinon.match.instanceOf(EventEmitter) });
            });

            describe("esm decorator", () => {
                it("should be passed to mocha reader", async () => {
                    await loadFiles_();

                    assert.calledWithMatch(readFiles, sinon.match.any, { esmDecorator: sinon.match.func });
                });

                it("should decorate esm module name with some random", async () => {
                    await loadFiles_();

                    const { esmDecorator } = readFiles.lastCall.args[1];
                    assert.match(esmDecorator("/some/file.mjs"), /^\/some\/file\.mjs\?rand=0\.[0-9]+$/);
                });

                it("should decorate with different random between calls", async () => {
                    await loadFiles_();
                    await loadFiles_();

                    const file = "/some/file.mjs";
                    const firstCallModuleName = readFiles.firstCall.args[1].esmDecorator(file);
                    const lastCallModuleName = readFiles.lastCall.args[1].esmDecorator(file);

                    assert.notEqual(firstCallModuleName, lastCallModuleName);
                });
            });
        });
    });

    describe("parse", () => {
        const parse_ = async ({ browserId, config } = {}) => {
            config = _.defaults(config, {
                desiredCapabilities: {},
            });

            const parser = BrowserTestParser.create();
            await parser.loadFiles([], makeConfigStub(), browserId);
            return parser.parse(browserId, config);
        };

        beforeEach(() => {
            sandbox.stub(Suite.prototype, "getTests").returns([]);
        });

        it("should execute build instructions", async () => {
            await parse_();

            assert.calledOnce(InstructionsList.prototype.exec);
        });

        it("should execute build instructions with passed browserId", async () => {
            await parse_({ browserId: "bro" });

            assert.calledWithMatch(InstructionsList.prototype.exec, { browserId: "bro" });
        });

        it("should execute build instructions with passed config", async () => {
            await parse_({ config: { foo: "bar" } });

            assert.calledWithMatch(InstructionsList.prototype.exec, { config: { foo: "bar" } });
        });

        it("should return tree tests", async () => {
            const tests = [new Test({ file: "foo/bar.js" })];
            Suite.prototype.getTests.returns(tests);

            const res = await parse_();

            assert.deepEqual(res, tests);
        });

        describe("root suite decorators", () => {
            let rootSuite;

            beforeEach(() => {
                rootSuite = {};

                InstructionsList.prototype.exec.callsFake(ctx => {
                    ctx.treeBuilder = new TreeBuilder();
                    for (let i = 0; i < InstructionsList.prototype.push.callCount; ++i) {
                        InstructionsList.prototype.push.getCall(i).args[0](ctx);
                    }

                    return new Suite();
                });

                sandbox.stub(TreeBuilder.prototype, "addTrap").callsFake(fn => fn(rootSuite));
            });

            it("root suite should be decorated with browser id", async () => {
                await parse_({ browserId: "bro" });

                assert.propertyVal(rootSuite, "browserId", "bro");
            });

            describe("browser version", () => {
                it("root suite should be decorated with browser version if exists", async () => {
                    const config = {
                        desiredCapabilities: {
                            version: "100500",
                            browserVersion: "500100",
                        },
                    };

                    await parse_({ config });

                    assert.propertyVal(rootSuite, "browserVersion", "500100");
                });

                it("root suite should be decorated with version if no browser version specified", async () => {
                    const config = {
                        desiredCapabilities: {
                            version: "100500",
                        },
                    };

                    await parse_({ config });

                    assert.propertyVal(rootSuite, "browserVersion", "100500");
                });
            });

            describe("test timeout", () => {
                it('root suite should not be decorated with timeout if "testTimeout" is not specified in config', async () => {
                    await parse_();

                    assert.notProperty(rootSuite, "timeout");
                });

                it('root suite should be decorated with timeout if "testTimeout" is specified in config', async () => {
                    const config = {
                        testTimeout: 100500,
                    };

                    await parse_({ config });

                    assert.propertyVal(rootSuite, "timeout", 100500);
                });

                it('root suite should be decorated with timeout even if "testTimeout" is set to 0', async () => {
                    const config = {
                        testTimeout: 0,
                    };

                    await parse_({ config });

                    assert.propertyVal(rootSuite, "timeout", 0);
                });
            });
        });

        describe("in case of duplicate test titles", () => {
            it("should reject for tests in the same file", async () => {
                const parser = BrowserTestParser.create();

                Suite.prototype.getTests.returns([
                    new Test({ title: "some test", file: "foo/bar.js" }),
                    new Test({ title: "some test", file: "foo/bar.js" }),
                ]);

                assert.throws(() => parser.parse(), "same title");
            });

            it("should reject for tests in different files", async () => {
                const parser = BrowserTestParser.create();

                Suite.prototype.getTests.returns([
                    new Test({ title: "some test", file: "foo/bar.js" }),
                    new Test({ title: "some test", file: "baz/qux.js" }),
                ]);

                assert.throws(() => parser.parse(), "same title");
            });
        });
    });
});
