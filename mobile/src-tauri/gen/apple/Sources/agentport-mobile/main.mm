#include "bindings/bindings.h"

extern "C" void agentport_push_prepare(void);

int main(int argc, char * argv[]) {
	agentport_push_prepare();
	ffi::start_app();
	return 0;
}
