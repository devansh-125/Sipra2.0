GO := $(shell which go 2>/dev/null || echo "C:/Program Files/Go/bin/go.exe")
CORE := services/core-go

.PHONY: test-integration
test-integration:
	cd $(CORE) && $(GO) test -v -timeout 5m ./test/...
